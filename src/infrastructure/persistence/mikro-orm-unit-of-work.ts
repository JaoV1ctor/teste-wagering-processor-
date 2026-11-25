import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports';
import {
  MikroOrmInboxRepository, MikroOrmLedgerRepository, MikroOrmOutboxRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletRepository,
} from './repositories';
import { isLockConflict, type RetryOptions, withTransientRetry } from './transient-retry';

/** O que a persistência informa para métrica; nunca altera o fluxo. Quem implementa é a camada de observabilidade. */
export interface PersistenceObserver {
  /** Cada falha transitória. `lockConflict`: deadlock, serialização ou lock_timeout; `willRetry`: ainda há tentativa interna. */
  transientFailure(failure: { lockConflict: boolean; willRetry: boolean }): void;
  /** Quanto o `SELECT ... FOR NO KEY UPDATE` da wallet esperou (inclusive quando falhou). */
  walletLockWaited(seconds: number): void;
}

const repositoriesFor = (em: EntityManager, observer: PersistenceObserver | undefined): Repositories => ({
  wallets: new MikroOrmWalletRepository(em, observer ? (seconds) => observer.walletLockWaited(seconds) : undefined),
  transactions: new MikroOrmWagerTransactionRepository(em),
  ledger: new MikroOrmLedgerRepository(em),
  inbox: new MikroOrmInboxRepository(em),
  outbox: new MikroOrmOutboxRepository(em),
});

/**
 * Prazo de CADA espera por lock (o Postgres o aplica por tentativa de obter um lock; não limita a espera total numa fila). O lock da wallet
 * dura uma transação curta (dezenas de ms), então uma espera de 3s indica transação travada; contra ela, as 3 tentativas somam ~9s e o
 * provedor recebe 503 + Retry-After. Estimativa, ajustável por `LOCK_TIMEOUT_MS`.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 3000;

export interface UnitOfWorkOptions {
  retry?: RetryOptions;
  lockTimeoutMs?: number;
  observer?: PersistenceObserver;
}

/** Cada chamada usa um fork novo do EntityManager: sem identity map compartilhado entre requisições. */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly observer: PersistenceObserver | undefined;
  private readonly retry: RetryOptions;
  private readonly lockTimeout: string;

  constructor(
    private readonly orm: MikroORM,
    { retry = {}, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, observer }: UnitOfWorkOptions = {},
  ) {
    this.observer = observer;
    this.retry = observer
      ? { ...retry, onTransientFailure: (error, willRetry) => observer.transientFailure({ lockConflict: isLockConflict(error), willRetry }) }
      : retry;
    this.lockTimeout = `${lockTimeoutMs}ms`;
  }

  /**
   * `set_config(..., true)` é o `SET LOCAL` parametrizável: vale só nesta transação e não vaza para a conexão do pool.
   * Precisa ser a 1ª instrução, antes do lock da wallet; ela não toca tabela, então a ordem de locks não muda.
   * Esgotar o prazo dá 55P03, tratado como transitório (retry curto; esgotado, 503).
   */
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return withTransientRetry(
      () =>
        this.orm.em.fork().transactional(async (em) => {
          await em.execute("select set_config('lock_timeout', ?, true)", [this.lockTimeout]);
          return work(repositoriesFor(em, this.observer));
        }),
      this.retry,
    );
  }

  read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return withTransientRetry(() => work(repositoriesFor(this.orm.em.fork(), this.observer)), this.retry);
  }
}
