import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import type { UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { optionalPositiveInt } from './infrastructure/env';
import { DEFAULT_LOCK_TIMEOUT_MS, MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from './infrastructure/persistence/orm.config';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';

const ORM = Symbol('ORM');
const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

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
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
