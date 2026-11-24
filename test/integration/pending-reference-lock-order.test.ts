// Ordem de locks do worker (SPEC D7, §6): o claim é uma transação própria e curta, sem wallet; o reprocesso trava a wallet PRIMEIRO
// e só então escreve na transação e no ledger (wallet -> transação -> ledger). Lê o SQL REALMENTE emitido ao Postgres real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, parkPendingReferences } from '../support/db';

const queries: string[] = [];
const rethrow = (error: unknown): never => {
  throw error;
};
const probe = createProbe(2);
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator], debug: ['query'], logger: (msg: string) => queries.push(msg) });
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const plain = (sql: string) => sql.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
const index = (statements: string[], pattern: RegExp): number => statements.findIndex((q) => pattern.test(q));

/** Divide o log em transações (de `begin` a `commit`/`rollback`). */
function transactionsIn(log: string[]): string[][] {
  const result: string[][] = [];
  for (const statement of log.map(plain)) {
    if (/\bbegin\b/.test(statement)) result.push([]);
    result.at(-1)?.push(statement);
  }
  return result;
}

async function reprocessLog(): Promise<string[][]> {
  await parkPendingReferences(probe);
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('100.00') });
  const base = { providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', money: brl('30.00') };
  const betId = `bet-${uuid()}`;
  const process = new ProcessWagerTransactionUseCase(uow);
  const refund: ProcessWagerCommand = {
    ...base, idempotencyKey: `k-${uuid()}`, externalTransactionId: `ext-${uuid()}`, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: betId,
  };
  expect((await process.execute(refund)).transaction.status).toBe(WagerTransactionStatus.PendingReference);
  await process.execute({ ...base, idempotencyKey: `k-${uuid()}`, externalTransactionId: betId, kind: WagerTransactionKind.Bet });

  queries.length = 0;
  const summary = await new ReprocessPendingReferencesUseCase(uow, { clock: () => new Date(Date.now() + 60_000), batchSize: 10, onError: rethrow }).runOnce();
  expect(summary).toMatchObject({ claimed: 1, processed: 1 });
  return transactionsIn(queries);
}

describe('ordem de locks do worker de PENDING_REFERENCE', () => {
  test('claim: transação própria, só em wager_transactions, com FOR UPDATE SKIP LOCKED e sem tocar a wallet', async () => {
    const [claim] = await reprocessLog();
    expect(claim).toBeDefined();
    const statements = claim as string[];
    expect(statements.some((q) => /for update skip locked/.test(q))).toBe(true);
    expect(statements.filter((q) => /wallets|wallet_ledger_entries/.test(q))).toEqual([]);
    expect(statements.some((q) => /\bcommit\b/.test(q))).toBe(true);
  });

  test('reprocesso: begin -> lock_timeout -> lock da wallet (FOR NO KEY UPDATE) -> update da transação -> update da wallet -> insert do ledger -> commit', async () => {
    const log = await reprocessLog();
    const statements = log[1] as string[];
    expect(log).toHaveLength(2);

    const lock = index(statements, /select .*from "?wallets"?.* for no key update/s);
    const updateTx = index(statements, /update "?wager_transactions"?/);
    const updateWallet = index(statements, /update "?wallets"?/);
    const insertLedger = index(statements, /insert into "?wallet_ledger_entries"?/);
    const commit = index(statements, /\bcommit\b/);

    expect(index(statements, /set_config\('lock_timeout'/)).toBe(1);
    expect(lock).toBe(2); // a wallet é a primeira instrução que toca uma tabela
    expect(statements.slice(0, lock).filter((q) => /wallets|wager_transactions|wallet_ledger_entries/.test(q))).toEqual([]);
    expect(updateTx).toBeGreaterThan(lock);
    expect(updateWallet).toBeGreaterThan(updateTx);
    expect(insertLedger).toBeGreaterThan(updateWallet);
    expect(commit).toBeGreaterThan(insertLedger);
    // A transação é relida depois do lock, nunca antes (outro processo pode tê-la resolvido).
    expect(index(statements, /from "?wager_transactions"?.*where.*"?id"?/s)).toBeGreaterThan(lock);
  });
});
