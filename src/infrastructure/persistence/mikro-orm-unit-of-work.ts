import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports';
import {
  MikroOrmInboxRepository, MikroOrmLedgerRepository, MikroOrmOutboxRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletRepository,
} from './repositories';
import { type RetryOptions, withTransientRetry } from './transient-retry';

const repositoriesFor = (em: EntityManager): Repositories => ({
  wallets: new MikroOrmWalletRepository(em),
  transactions: new MikroOrmWagerTransactionRepository(em),
  ledger: new MikroOrmLedgerRepository(em),
  inbox: new MikroOrmInboxRepository(em),
  outbox: new MikroOrmOutboxRepository(em),
});

/**
 * Quanto uma transação espera por qualquer lock. O lock da wallet dura uma transação curta (dezenas de ms): 3s é ~100x essa margem,
 * então estourar significa transação travada, não fila normal. Com 3 tentativas o pior caso fica em ~9s, abaixo de um timeout típico
 * de gateway (10s): o provedor recebe 503 + Retry-After em vez de uma conexão pendurada. Estimativa, ajustável por `LOCK_TIMEOUT_MS`.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 3000;

export interface UnitOfWorkOptions {
  retry?: RetryOptions;
  lockTimeoutMs?: number;
}

/** Cada chamada usa um fork novo do EntityManager: sem identity map compartilhado entre requisições. */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly retry: RetryOptions;
  private readonly lockTimeout: string;

  constructor(
    private readonly orm: MikroORM,
    { retry = {}, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: UnitOfWorkOptions = {},
  ) {
    this.retry = retry;
    this.lockTimeout = `${lockTimeoutMs}ms`;
  }

  /**
   * `set_config(..., true)` é o `SET LOCAL` parametrizável: vale só nesta transação e não vaza para a conexão do pool.
   * Precisa ser a 1ª instrução, antes do lock da wallet (SPEC D2); ela não toca tabela, então a ordem de locks não muda.
   * Esgotar o prazo dá 55P03, tratado como transitório (retry curto; esgotado, 503).
   */
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return withTransientRetry(
      () =>
        this.orm.em.fork().transactional(async (em) => {
          await em.execute("select set_config('lock_timeout', ?, true)", [this.lockTimeout]);
          return work(repositoriesFor(em));
        }),
      this.retry,
    );
  }

  read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return withTransientRetry(() => work(repositoriesFor(this.orm.em.fork())), this.retry);
  }
}
