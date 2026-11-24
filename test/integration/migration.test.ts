import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type Orm, businessTables, initOrm } from '../support/db';

let orm: Orm;
const EXPECTED = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

beforeAll(async () => {
  orm = await initOrm();
});
afterAll(async () => {
  await orm.migrator.up(); // deixa o schema aplicado para os demais testes de integração
  await orm.close();
});

test('migration up → down → up (reversível)', async () => {
  // estado limpo, qualquer que seja o ponto de partida
  while ((await orm.migrator.getExecuted()).length > 0) await orm.migrator.down();
  expect(await businessTables(orm)).toEqual([]);

  await orm.migrator.up();
  expect(await businessTables(orm)).toEqual(EXPECTED);

  await orm.migrator.down();
  expect(await businessTables(orm)).toEqual([]);
  const leftovers = await orm.em.getConnection().execute<{ n: string }[]>(
    `select count(*)::text as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname in ('wallets_guard','wager_transactions_guard','ledger_immutable','ledger_chain_check','assert_wallet_matches_ledger')`,
  );
  expect(leftovers[0]!.n).toBe('0'); // o down também remove as funções

  await orm.migrator.up();
  expect(await businessTables(orm)).toEqual(EXPECTED);
});
