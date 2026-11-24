// Ordem de locks e de escrita (SPEC D2 e §6): wallet -> transação -> ledger. Lê o SQL REALMENTE emitido ao Postgres real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { ensureSchema } from '../support/db';

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
afterAll(() => orm.close());

const brl = (v: string) => Money.fromString(v, 'BRL');
const plain = (sql: string) => sql.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();

async function emitted(kind: WagerTransactionKind, amount: string): Promise<{ statements: string[] }> {
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('100.00') });
  const externalTransactionId = `ext-${uuid()}`;
  const cmd: ProcessWagerCommand = {
    idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'r', gameId: 'g', kind, money: brl(amount),
  };
  queries.length = 0;
  await useCase.execute(cmd);
  const all = queries.map(plain);
  return { statements: all.slice(all.findIndex((q) => /\bbegin\b/.test(q))) };
}

const indexOf = (statements: string[], pattern: RegExp): number => statements.findIndex((q) => pattern.test(q));
const LOCK = /select .*from "?wallets"?.* for no key update/s;
const LOCK_TIMEOUT = /set_config\('lock_timeout'/;
const INSERT_TX = /insert into "?wager_transactions"?/;
const UPDATE_WALLET = /update "?wallets"?/;
const INSERT_LEDGER = /insert into "?wallet_ledger_entries"?/;

describe('ordem de locks e escrita do ProcessWagerTransaction', () => {
  test('BET processada: begin -> lock da wallet (FOR NO KEY UPDATE) -> insert transação -> update wallet -> insert ledger -> commit', async () => {
    const { statements } = await emitted(WagerTransactionKind.Bet, '30.00');
    const begin = indexOf(statements, /\bbegin\b/);
    const lock = indexOf(statements, LOCK);
    const insertTx = indexOf(statements, INSERT_TX);
    const updateWallet = indexOf(statements, UPDATE_WALLET);
    const insertLedger = indexOf(statements, INSERT_LEDGER);
    const commit = indexOf(statements, /\bcommit\b/);

    expect(begin).toBe(0);
    expect(indexOf(statements, LOCK_TIMEOUT)).toBe(1); // SET LOCAL lock_timeout: não toca tabela, vem antes do lock
    expect(lock).toBe(2); // a wallet é a primeira instrução que toca uma tabela
    expect(lock).toBeLessThan(insertTx);
    expect(insertTx).toBeLessThan(insertLedger);
    expect(updateWallet).toBeGreaterThan(insertTx);
    expect(insertLedger).toBeGreaterThan(updateWallet);
    expect(commit).toBeGreaterThan(insertLedger);
  });

  test('nenhuma instrução toca a wallet antes do lock', async () => {
    const { statements } = await emitted(WagerTransactionKind.Bet, '30.00');
    const lock = indexOf(statements, LOCK);
    expect(lock).toBeGreaterThan(indexOf(statements, LOCK_TIMEOUT));
    expect(statements.slice(0, lock).filter((q) => /wallets|wager_transactions|wallet_ledger_entries/.test(q))).toEqual([]);
  });

  test('a transação é gravada UMA vez, já no estado final: 1 insert, nenhum update de wager_transactions', async () => {
    const { statements } = await emitted(WagerTransactionKind.Bet, '30.00');
    expect(statements.filter((q) => INSERT_TX.test(q))).toHaveLength(1);
    expect(statements.filter((q) => /update "?wager_transactions"?/.test(q))).toHaveLength(0);
  });

  test('rejeição (saldo insuficiente): lock -> insert transação -> commit; sem update de wallet nem ledger', async () => {
    const { statements } = await emitted(WagerTransactionKind.Bet, '500.00');
    expect(indexOf(statements, LOCK)).toBe(2);
    expect(indexOf(statements, INSERT_TX)).toBeGreaterThan(1);
    expect(indexOf(statements, UPDATE_WALLET)).toBe(-1);
    expect(indexOf(statements, INSERT_LEDGER)).toBe(-1);
  });

  test('LOSS: lock -> insert transação; sem update de wallet nem ledger', async () => {
    const { statements } = await emitted(WagerTransactionKind.Loss, '30.00');
    expect(indexOf(statements, LOCK)).toBe(2);
    expect(indexOf(statements, UPDATE_WALLET)).toBe(-1);
    expect(indexOf(statements, INSERT_LEDGER)).toBe(-1);
  });

  test('o INSERT da transação usa ON CONFLICT (idempotency_key) DO NOTHING', async () => {
    const { statements } = await emitted(WagerTransactionKind.Bet, '30.00');
    const insert = statements.find((q) => INSERT_TX.test(q)) ?? '';
    expect(insert).toMatch(/on conflict \(\s*"?idempotency_key"?\s*\) do nothing/);
  });
});
