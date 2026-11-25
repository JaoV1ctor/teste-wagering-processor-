// Migrations reversíveis, em um banco PRÓPRIO: descer e subir o schema do banco compartilhado apagaria dados de outros testes, e a
// reversão da unicidade por provedor falha (de propósito) quando há uma chave usada por mais de um provedor.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Orm, businessTables, createEmptyDatabase, initOrm, type TemporaryDatabase } from '../support/db';

let database: TemporaryDatabase;
let orm: Orm;
const EXPECTED = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];
const GLOBAL = 'UNIQUE (idempotency_key)';
const PER_PROVIDER = 'UNIQUE (provider_id, idempotency_key)';
const EXTERNAL = 'UNIQUE (provider_id, external_transaction_id)';

beforeAll(async () => {
  database = await createEmptyDatabase();
  orm = await initOrm(database.url);
});
afterAll(async () => {
  await orm.close();
  await database.drop();
});

const sql = <T extends object>(text: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(text, params);
const uniques = async () =>
  (await sql<{ d: string }>(
    "select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = to_regclass('wager_transactions') and contype = 'u' order by 1",
  )).map((row) => row.d);
const executed = async () => (await orm.migrator.getExecuted()).map((migration) => migration.name);

test('up → down → up das duas migrations (reversíveis)', async () => {
  await orm.migrator.up();
  expect(await businessTables(orm)).toEqual(EXPECTED);
  expect(await executed()).toEqual(['Migration20260101000000_init', 'Migration20261125000000_idempotency_per_provider']);
  expect(await uniques()).toEqual([EXTERNAL, PER_PROVIDER]);

  await orm.migrator.down(); // só a última: a chave volta a ser global
  expect(await uniques()).toEqual([GLOBAL, EXTERNAL]);

  await orm.migrator.down(); // a inicial: some tudo
  expect(await businessTables(orm)).toEqual([]);
  const leftovers = await sql<{ n: string }>(
    `select count(*)::text as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('wallets_guard','wager_transactions_guard','ledger_immutable','ledger_chain_check','assert_wallet_matches_ledger')`,
  );
  expect(leftovers[0]!.n).toBe('0'); // o down também remove as funções

  await orm.migrator.up();
  expect(await businessTables(orm)).toEqual(EXPECTED);
  expect(await uniques()).toEqual([EXTERNAL, PER_PROVIDER]);
});

test('com a mesma chave em dois provedores, o down falha dizendo o motivo e não altera o schema nem os dados', async () => {
  await orm.migrator.up();
  const walletId = uuid();
  const playerId = uuid();
  await sql("insert into wallets (id, player_id, currency, balance) values (?, ?, 'BRL', 0)", [walletId, playerId]);
  for (const provider of ['alfa', 'beta']) {
    await sql(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, failure_code)
       values (?, ?, 'e', 'mesma-chave', ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'REJECTED', 'X')`,
      [uuid(), provider, 'a'.repeat(64), walletId, playerId],
    );
  }

  await expect(orm.migrator.down()).rejects.toThrow(/usada\(s\) por mais de um provedor; a unicidade global não pode ser restaurada/);

  expect(await uniques()).toEqual([EXTERNAL, PER_PROVIDER]);
  expect(await executed()).toHaveLength(2);
  expect(await sql('select provider_id from wager_transactions order by 1')).toEqual([{ provider_id: 'alfa' }, { provider_id: 'beta' }]);
});
