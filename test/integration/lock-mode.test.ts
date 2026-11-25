// Comportamento do MikroORM 7 sobre locks: o ORM só emite FOR UPDATE; FOR NO KEY UPDATE exige SQL parametrizado.
// Postgres REAL do compose. Fundamenta a escolha de lock (docs/ARCHITECTURE.md).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { WalletEntity } from '../../src/infrastructure/persistence/wallet.entity';
import { WalletMapper } from '../../src/infrastructure/persistence/wallet.mapper';
import { createProbe, ensureSchema } from '../support/db';

const queries: string[] = [];
const probe = createProbe(2);
let orm: MikroORM;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator], debug: ['query'], logger: (msg: string) => queries.push(msg) });
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

/** Wallet com saldo 0.00 (sem ledger: o trigger deferido só aceita saldo 0 sem lançamentos). */
async function insertEmptyWallet(): Promise<string> {
  const { wallet } = Wallet.create({
    id: uuid(), playerId: uuid(), initialBalance: Money.zero('BRL'), openingTransactionId: uuid(), openingEntryId: uuid(), now: new Date(),
  });
  await orm.em.fork().persist(WalletMapper.toEntity(wallet)).flush();
  return wallet.id;
}

const plain = (sql: string) => sql.replace(/\x1b\[[0-9;]*m/g, '');

describe('LockMode do MikroORM', () => {
  const lockSql = async (mode: LockMode): Promise<string> => {
    const id = await insertEmptyWallet();
    queries.length = 0;
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletEntity, { id }, { lockMode: mode });
    });
    const select = queries.map(plain).find((q) => /from "wallets"/i.test(q));
    expect(select).toBeDefined();
    return select ?? '';
  };

  test('PESSIMISTIC_WRITE gera FOR UPDATE (o ORM não tem FOR NO KEY UPDATE)', async () => {
    const sql = await lockSql(LockMode.PESSIMISTIC_WRITE);
    expect(sql).toMatch(/for update\b/i);
    expect(sql).not.toMatch(/no key/i);
  });

  test('outros modos pessimistas: SHARE, SKIP LOCKED e NOWAIT', async () => {
    expect(await lockSql(LockMode.PESSIMISTIC_READ)).toMatch(/for share/i);
    expect(await lockSql(LockMode.PESSIMISTIC_PARTIAL_WRITE)).toMatch(/for update skip locked/i);
    expect(await lockSql(LockMode.PESSIMISTIC_WRITE_OR_FAIL)).toMatch(/for update nowait/i);
  });

  test('a wallet é a PRIMEIRA instrução depois do BEGIN na transação com lock', async () => {
    const id = await insertEmptyWallet();
    queries.length = 0;
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });
    const statements = queries.map(plain);
    const begin = statements.findIndex((q) => /\bbegin\b/i.test(q));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(statements[begin + 1]).toMatch(/for update/i);
  });

  test('FOR NO KEY UPDATE via SQL parametrizado, dentro de em.transactional, segura a linha e NÃO bloqueia KEY SHARE', async () => {
    const id = await insertEmptyWallet();
    let seenInTx: string | undefined;
    await orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<{ balance: string }[]>('select balance from wallets where id = ? for no key update', [id]);
      seenInTx = rows[0]?.balance;

      const other = await probe.connect();
      try {
        await other.query('BEGIN');
        await expect(other.query('select 1 from wallets where id = $1 for no key update nowait', [id])).rejects.toThrow(/could not obtain lock/);
        await other.query('ROLLBACK');
        // KEY SHARE é o lock que a checagem de FK de um INSERT toma na wallet
        await other.query('BEGIN');
        const keyShare = await other.query('select 1 from wallets where id = $1 for key share nowait', [id]);
        expect(keyShare.rowCount).toBe(1);
        await other.query('ROLLBACK');
      } finally {
        other.release();
      }
    });
    expect(seenInTx).toBe('0.00');
  });

  test('FOR UPDATE do ORM bloqueia até KEY SHARE (origem do deadlock da ordem errada de locks)', async () => {
    const id = await insertEmptyWallet();
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const other = await probe.connect();
      try {
        await other.query('BEGIN');
        await expect(other.query('select 1 from wallets where id = $1 for key share nowait', [id])).rejects.toThrow(/could not obtain lock/);
        await other.query('ROLLBACK');
      } finally {
        other.release();
      }
    });
  });
});
