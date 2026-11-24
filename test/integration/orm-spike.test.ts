// SPIKE Fase 0: MikroORM 7 sob Bun, com decorators legacy + reflect-metadata, domínio de construtor privado e mapper.
// Postgres REAL do compose. Também registra o SQL que o LockMode gera (relatado em docs/ARCHITECTURE.md).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import { Wallet } from '../../src/domain/wallet';
import { requireEnv } from '../../src/infrastructure/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { WalletEntity } from '../../src/infrastructure/persistence/wallet.entity';
import { WalletMapper } from '../../src/infrastructure/persistence/wallet.mapper';

const queries: string[] = [];
let orm: Awaited<ReturnType<typeof init>>;
const probe = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 2 });

const init = () =>
  MikroORM.init({
    ...createOrmConfig(),
    extensions: [Migrator],
    debug: ['query'],
    logger: (msg: string) => queries.push(msg),
  });

beforeAll(async () => {
  orm = await init();
  await orm.migrator.up();
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

/** Cria uma wallet com saldo 0.00 (sem ledger: o trigger deferido só aceita saldo 0 sem lançamentos). */
async function insertEmptyWallet(): Promise<string> {
  const id = uuid();
  const now = new Date();
  const entity = new WalletEntity();
  Object.assign(entity, { id, playerId: uuid(), currency: 'BRL', balance: '0.00', version: 1, createdAt: now, updatedAt: now });
  await orm.em.fork().persist(entity).flush();
  return id;
}

describe('persistência via entidade + mapper + domínio', () => {
  test('persiste e relê uma wallet; domínio nasce por rehydrate (construtor privado)', async () => {
    const id = await insertEmptyWallet();

    const entity = await orm.em.fork().findOneOrFail(WalletEntity, { id }); // fork limpo = lê do banco, não do identity map
    expect(entity).toBeInstanceOf(WalletEntity);
    expect(typeof entity.balance).toBe('string'); // NUMERIC não vira number
    expect(entity.balance).toBe('0.00');

    const wallet = WalletMapper.toDomain(entity);
    expect(wallet).toBeInstanceOf(Wallet);
    expect(wallet.id).toBe(id);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balanceCents).toBe(0n);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toBeInstanceOf(Date);

    // ida e volta: domínio -> entidade preserva o estado
    const back = WalletMapper.toEntity(wallet);
    expect(back.balance).toBe('0.00');
    expect(back.id).toBe(id);
  });

  test('mapper converte NUMERIC(19,2) sem float e rejeita formato inesperado', () => {
    const e = new WalletEntity();
    Object.assign(e, { id: uuid(), playerId: uuid(), currency: 'BRL', balance: '12345678901234567.89', version: 3, createdAt: new Date(), updatedAt: new Date() });
    const w = WalletMapper.toDomain(e);
    expect(w.balanceCents).toBe(1234567890123456789n); // acima de Number.MAX_SAFE_INTEGER: sem perda
    expect(WalletMapper.toEntity(w).balance).toBe('12345678901234567.89');
    e.balance = '10.5';
    expect(() => WalletMapper.toDomain(e)).toThrow();
  });
});

describe('LockMode do MikroORM: SQL gerado', () => {
  const lockSql = async (mode: LockMode): Promise<string> => {
    const id = await insertEmptyWallet();
    queries.length = 0;
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletEntity, { id }, { lockMode: mode });
    });
    const select = queries.find((q) => /from "wallets"/i.test(q) || /from `wallets`/i.test(q));
    expect(select).toBeDefined();
    return select!;
  };

  test('PESSIMISTIC_WRITE gera FOR UPDATE (não existe FOR NO KEY UPDATE)', async () => {
    const sql = await lockSql(LockMode.PESSIMISTIC_WRITE);
    console.log('PESSIMISTIC_WRITE        =>', sql);
    expect(sql).toMatch(/for update\b/i);
    expect(sql).not.toMatch(/no key/i);
  });

  test('demais modos pessimistas (informativo)', async () => {
    for (const [name, mode] of [
      ['PESSIMISTIC_READ', LockMode.PESSIMISTIC_READ],
      ['PESSIMISTIC_PARTIAL_WRITE', LockMode.PESSIMISTIC_PARTIAL_WRITE],
      ['PESSIMISTIC_WRITE_OR_FAIL', LockMode.PESSIMISTIC_WRITE_OR_FAIL],
    ] as const) {
      console.log(`${name.padEnd(25)}=>`, await lockSql(mode));
    }
  });

  test('a wallet é a PRIMEIRA instrução depois do BEGIN na transação com lock', async () => {
    const id = await insertEmptyWallet();
    queries.length = 0;
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });
    const stmts = queries.map((q) => q.replace(/\x1b\[[0-9;]*m/g, ''));
    console.log(stmts.join('\n'));
    const begin = stmts.findIndex((q) => /\bbegin\b/i.test(q));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(stmts[begin + 1]).toMatch(/for update/i);
  });

  test('FOR NO KEY UPDATE via SQL parametrizado dentro de em.transactional segura a linha de verdade', async () => {
    const id = await insertEmptyWallet();
    let seenInTx: string | undefined;
    await orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<{ balance: string }[]>('select balance from wallets where id = ? for no key update', [id]);
      seenInTx = rows[0]?.balance;

      // outra conexão: NO KEY UPDATE conflita com NO KEY UPDATE...
      const c = await probe.connect();
      try {
        await c.query('BEGIN');
        await expect(c.query('select 1 from wallets where id = $1 for no key update nowait', [id])).rejects.toThrow(/could not obtain lock/);
        await c.query('ROLLBACK');
        // ...mas NÃO conflita com KEY SHARE (checagem de FK): FOR UPDATE bloquearia isto
        await c.query('BEGIN');
        const ks = await c.query('select 1 from wallets where id = $1 for key share nowait', [id]);
        expect(ks.rowCount).toBe(1);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });
    expect(seenInTx).toBe('0.00');
  });

  test('FOR UPDATE do MikroORM bloqueia até KEY SHARE (o que causa o deadlock da ordem errada)', async () => {
    const id = await insertEmptyWallet();
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const c = await probe.connect();
      try {
        await c.query('BEGIN');
        await expect(c.query('select 1 from wallets where id = $1 for key share nowait', [id])).rejects.toThrow(/could not obtain lock/);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });
  });
});
