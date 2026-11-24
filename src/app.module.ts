import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import type { UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { DEFAULT_REPROCESS_BATCH_SIZE, ReprocessPendingReferencesUseCase } from './application/reprocess-pending-references.use-case';
import { optionalPositiveInt } from './infrastructure/env';
import { DEFAULT_LOCK_TIMEOUT_MS, MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { describeError, logJson } from './infrastructure/observability/json-log';
import { createOrmConfig } from './infrastructure/persistence/orm.config';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';

const ORM = Symbol('ORM');
const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
const POLL_INTERVAL_MS = 1000;

/** Composição: os casos de uso são classes puras; o Nest só os instancia com as portas já resolvidas. */
@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: ORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    {
      provide: UNIT_OF_WORK,
      inject: [ORM],
      useFactory: (orm: MikroORM) =>
        new MikroOrmUnitOfWork(orm, { lockTimeoutMs: optionalPositiveInt('LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS) }),
    },
    { provide: CreateWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new CreateWalletUseCase(uow) },
    { provide: GetWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow) },
    { provide: ListLedgerUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new ListLedgerUseCase(uow) },
    { provide: ProcessWagerTransactionUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new ProcessWagerTransactionUseCase(uow) },
    { provide: GetWagerTransactionUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow) },
    {
      provide: ReprocessPendingReferencesUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) =>
        new ReprocessPendingReferencesUseCase(uow, {
          onError: (error, { id, walletId }) => logJson('error', 'pending_reference_reprocess_failed', { transactionId: id, walletId, ...describeError(error) }),
        }),
    },
    {
      // Só é criado aqui; quem o inicia é o main.ts (os testes sobem o módulo sem loop em background).
      provide: PendingReferenceWorker,
      inject: [ReprocessPendingReferencesUseCase],
      useFactory: (useCase: ReprocessPendingReferencesUseCase) =>
        new PendingReferenceWorker(useCase, {
          pollIntervalMs: POLL_INTERVAL_MS,
          batchSize: DEFAULT_REPROCESS_BATCH_SIZE,
          onError: (error) => logJson('error', 'pending_reference_worker_pass_failed', describeError(error)),
        }),
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker,
  ) {}

  /** O worker para antes de o ORM fechar: a passada em andamento termina e nenhuma outra começa. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
