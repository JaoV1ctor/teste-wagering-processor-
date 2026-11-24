// Concorrência real (Postgres real, requisições HTTP simultâneas) em POST /wallets.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type Api, newPlayerId, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';

const probe = createProbe(4);
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
});

const create = (playerId: string) => api.call('POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });

test('50 criações simultâneas da mesma wallet: 1 vence (201), 49 conflitam (409), 1 OPENING, 1 lançamento', async () => {
  const playerId = newPlayerId();
  const results = await Promise.all(Array.from({ length: 50 }, () => create(playerId)));

  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.status === 409)).toHaveLength(49);
  expect(results.every((r) => r.status === 201 || r.body.code === 'WALLET_ALREADY_EXISTS')).toBe(true);

  const { rows: wallets } = await probe.query<{ id: string }>('select id from wallets where player_id = $1', [playerId]);
  expect(wallets).toHaveLength(1);
  const walletId = wallets[0]?.id ?? '';
  const { rows: openings } = await probe.query("select 1 from wager_transactions where player_id = $1 and kind = 'OPENING'", [playerId]);
  expect(openings).toHaveLength(1);
  expect(await ledgerBalance(probe, walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
});

test('50 wallets de players distintos em paralelo: todas criadas, cada saldo == ledger', async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => create(newPlayerId())));

  expect(results.every((r) => r.status === 201)).toBe(true);
  expect(new Set(results.map((r) => r.body.id)).size).toBe(50);
  for (const r of results) {
    expect(await ledgerBalance(probe, r.body.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  }
});
