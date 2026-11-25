// Atomicidade de POST /wallets: wallet + OPENING + ledger, tudo ou nada. Postgres REAL; a falha é injetada no repositório do ledger.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import type { LedgerRepository, OutboxRepository, UnitOfWork } from '../../src/application/ports';
import { Money } from '../../src/domain/money';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, divergentWallets, ensureSchema } from '../support/db';

const probe = createProbe(2);
let orm: MikroORM;
let real: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  real = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  const divergent = await divergentWallets(probe);
  await probe.end();
  await orm.close();
  expect(divergent).toEqual([]); // invariante final: wallet.balance == saldo reconstruído pelo ledger
});

const failingLedger = (boom: Error): UnitOfWork => ({
  read: (work) => real.read(work),
  run: (work) =>
    real.run((repos) => {
      const ledger: LedgerRepository = Object.assign(Object.create(repos.ledger), { add: async () => { throw boom; } });
      return work({ ...repos, ledger });
    }),
});

test('falha ao gravar o lançamento: nem a wallet nem a transação OPENING permanecem', async () => {
  const boom = new Error('falha injetada ao gravar o lançamento');
  const playerId = uuid();
  const useCase = new CreateWalletUseCase(failingLedger(boom));

  await expect(useCase.execute({ playerId, initialBalance: Money.fromString('100.00', 'BRL') })).rejects.toBe(boom);

  const { rows: wallets } = await probe.query('select 1 from wallets where player_id = $1', [playerId]);
  const { rows: transactions } = await probe.query('select 1 from wager_transactions where player_id = $1', [playerId]);
  expect(wallets).toHaveLength(0);
  expect(transactions).toHaveLength(0);
});

test('depois da falha, o mesmo player consegue criar a wallet (nada ficou preso)', async () => {
  const playerId = uuid();
  await expect(new CreateWalletUseCase(failingLedger(new Error('x'))).execute({ playerId, initialBalance: Money.fromString('5', 'BRL') })).rejects.toThrow();
  const wallet = await new CreateWalletUseCase(real).execute({ playerId, initialBalance: Money.fromString('5', 'BRL') });
  expect(wallet.balance.toString()).toBe('5.00');
});

const failingOutbox = (boom: Error): UnitOfWork => ({
  read: (work) => real.read(work),
  run: (work) =>
    real.run((repos) => {
      const outbox: OutboxRepository = Object.assign(Object.create(repos.outbox), { add: async () => { throw boom; } });
      return work({ ...repos, outbox });
    }),
});

test('falha ao gravar o evento: wallet, OPENING, lançamento e eventos não permanecem (evento e fato são um só commit)', async () => {
  const boom = new Error('falha injetada ao gravar o evento');
  const playerId = uuid();

  await expect(new CreateWalletUseCase(failingOutbox(boom)).execute({ playerId, initialBalance: Money.fromString('100.00', 'BRL') })).rejects.toBe(boom);

  const { rows: wallets } = await probe.query('select 1 from wallets where player_id = $1', [playerId]);
  const { rows: transactions } = await probe.query('select 1 from wager_transactions where player_id = $1', [playerId]);
  const { rows: events } = await probe.query("select 1 from outbox_messages where payload->'data'->>'playerId' = $1", [playerId]);
  expect(wallets).toHaveLength(0);
  expect(transactions).toHaveLength(0);
  expect(events).toHaveLength(0);
});
