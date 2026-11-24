import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports';
import { MikroOrmLedgerRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletRepository } from './repositories';
import { type RetryOptions, withTransientRetry } from './transient-retry';

const repositoriesFor = (em: EntityManager): Repositories => ({
  wallets: new MikroOrmWalletRepository(em),
  transactions: new MikroOrmWagerTransactionRepository(em),
  ledger: new MikroOrmLedgerRepository(em),
});

/** Cada chamada usa um fork novo do EntityManager: sem identity map compartilhado entre requisições. */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly retry: RetryOptions = {},
  ) {}

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return withTransientRetry(() => this.orm.em.fork().transactional((em) => work(repositoriesFor(em))), this.retry);
  }

  read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return withTransientRetry(() => work(repositoriesFor(this.orm.em.fork())), this.retry);
  }
}
