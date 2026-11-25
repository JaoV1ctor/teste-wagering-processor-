// Ordem de locks e de escrita com o outbox: wallet -> transação -> ledger -> outbox. Lê o SQL REALMENTE emitido ao Postgres real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, divergentWallets, ensureSchema, parkOutbox, parkPendingReferences } from '../support/db';

const probe = createProbe(2);
const queries: string[] = [];
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let useCase: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator], debug: ['query'], logger: (msg: string) => queries.push(msg) });
  uow = new MikroOrmUnitOfWork(orm);
  useCase = new ProcessWagerTransactionUseCase(uow);
});
afterAll(async () => {
  const divergent = await divergentWallets(probe);
  await probe.end();
  await orm.close();
  expect(divergent).toEqual([]); // invariante final: wallet.balance == saldo reconstruído pelo ledger
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const plain = (sql: string) => sql.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
const indexOf = (statements: string[], pattern: RegExp): number => statements.findIndex((q) => pattern.test(q));
const LOCK = /select .*from "?wallets"?.* for no key update/s;
const INSERT_TX = /insert into "?wager_transactions"?/;
const UPDATE_TX = /update "?wager_transactions"?/;
const UPDATE_WALLET = /update "?wallets"?/;
const INSERT_LEDGER = /insert into "?wallet_ledger_entries"?/;
const INSERT_OUTBOX = /insert into "?outbox_messages"?/;
const COMMIT = /\bcommit\b/;

/** Instruções da PRIMEIRA transação emitida por `run` (do `begin` ao `commit`). */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  queries.length = 0;
  await run();
  const all = queries.map(plain);
  const begin = all.findIndex((q) => /\bbegin\b/.test(q));
  const commit = all.findIndex((q, i) => i > begin && COMMIT.test(q));
  return all.slice(begin, commit + 1);
}

async function submit(kind: WagerTransactionKind, amount: string): Promise<string[]> {
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('100.00') });
  await parkOutbox(probe); // os eventos da abertura não fazem parte do que cada teste observa
  const externalTransactionId = `ext-${uuid()}`;
  const cmd: ProcessWagerCommand = {
    idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'r', gameId: 'g', kind, money: brl(amount),
  };
  return statementsOf(() => useCase.execute(cmd));
}

describe('submissão (HTTP e SQS usam o mesmo caso de uso)', () => {
  test('BET processada: lock da wallet -> transação -> update wallet -> ledger -> outbox (2 eventos) -> commit', async () => {
    const statements = await submit(WagerTransactionKind.Bet, '30.00');
    const lock = indexOf(statements, LOCK);
    const insertTx = indexOf(statements, INSERT_TX);
    const insertLedger = indexOf(statements, INSERT_LEDGER);
    const insertOutbox = indexOf(statements, INSERT_OUTBOX);

    expect(lock).toBe(2); // begin, set_config(lock_timeout), lock
    expect(lock).toBeLessThan(insertTx);
    expect(insertTx).toBeLessThan(insertLedger);
    expect(insertLedger).toBeLessThan(insertOutbox); // o outbox é o ÚLTIMO a escrever
    expect(statements.filter((q) => INSERT_OUTBOX.test(q))).toHaveLength(2);
    expect(statements.findLastIndex((q) => INSERT_OUTBOX.test(q))).toBeLessThan(statements.findIndex((q) => COMMIT.test(q)));
    expect(statements.slice(0, insertOutbox).some((q) => /outbox_messages/.test(q))).toBe(false); // nada do outbox antes
  });

  test('LOSS e REJECTED: transação -> outbox (1 evento), sem update de wallet nem ledger', async () => {
    for (const [kind, amount] of [[WagerTransactionKind.Loss, '30.00'], [WagerTransactionKind.Bet, '500.00']] as const) {
      const statements = await submit(kind, amount);
      expect(indexOf(statements, LOCK)).toBe(2);
      expect(indexOf(statements, INSERT_TX)).toBeLessThan(indexOf(statements, INSERT_OUTBOX));
      expect(statements.filter((q) => INSERT_OUTBOX.test(q))).toHaveLength(1);
      expect(indexOf(statements, UPDATE_WALLET)).toBe(-1);
      expect(indexOf(statements, INSERT_LEDGER)).toBe(-1);
    }
  });
});

describe('worker de PENDING_REFERENCE', () => {
  test('reprocesso que resolve: lock da wallet -> update da transação -> update wallet -> ledger -> outbox -> commit', async () => {
    await parkPendingReferences(probe);
    const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('100.00') });
    const betId = `ext-${uuid()}`;
    const refundId = `ext-${uuid()}`;
    const common = { providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', money: brl('30.00') };
    const early = await useCase.execute({
      ...common, idempotencyKey: `k-${refundId}`, externalTransactionId: refundId, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: betId,
    });
    await useCase.execute({ ...common, idempotencyKey: `k-${betId}`, externalTransactionId: betId, kind: WagerTransactionKind.Bet });

    const worker = new ReprocessPendingReferencesUseCase(uow, { onError: (error) => { throw error; } });
    const statements = await statementsOf(() => worker.reprocessOne({ id: early.transaction.id, walletId: wallet.id }));
    const lock = indexOf(statements, LOCK);
    expect(lock).toBe(2);
    expect(lock).toBeLessThan(indexOf(statements, UPDATE_TX));
    expect(indexOf(statements, UPDATE_TX)).toBeLessThan(indexOf(statements, INSERT_LEDGER));
    expect(indexOf(statements, INSERT_LEDGER)).toBeLessThan(indexOf(statements, INSERT_OUTBOX));
    expect(statements.filter((q) => INSERT_OUTBOX.test(q))).toHaveLength(2);
  });
});

describe('publisher', () => {
  test('o claim é uma transação curta SEM wallet nem ledger, com FOR UPDATE SKIP LOCKED; marcar publicado é outra transação, depois do envio', async () => {
    await parkOutbox(probe);
    await submit(WagerTransactionKind.Loss, '1.00');
    const published: string[] = [];
    const publisher = new PublishOutboxUseCase(
      uow,
      { publish: async (message) => void published.push(message.id) },
      { onError: (error) => { throw error; } },
    );

    queries.length = 0;
    expect(await publisher.runOnce()).toMatchObject({ claimed: 1, published: 1 });
    const all = queries.map(plain);
    const claim = all.findIndex((q) => /for update skip locked/.test(q));
    expect(claim).toBeGreaterThan(-1);
    expect(all.some((q) => /wallets|wallet_ledger_entries|wager_transactions/.test(q))).toBe(false);
    const firstCommit = all.findIndex((q) => COMMIT.test(q));
    expect(firstCommit).toBeGreaterThan(claim); // o claim já foi confirmado...
    expect(all.slice(firstCommit + 1).findIndex((q) => /update "?outbox_messages"?/.test(q))).toBeGreaterThan(-1); // ...antes de marcar publicado
    expect(published).toHaveLength(1);
  });
});
