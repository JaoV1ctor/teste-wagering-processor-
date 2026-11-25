// Concorrência real (Postgres real, requisições HTTP simultâneas) em POST /wagering/transactions. Cenários #1, #2 e #3.
// Invariante final em todos: wallet.balance == saldo reconstruído pelo ledger.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

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

const money = (amount: string) => ({ amount, currency: 'BRL' });
const post = (payload: ReturnType<typeof wagerPayload>) => submit(api, payload, defaultKey(payload));
const countBy = async (sql: string, params: unknown[]) => (await probe.query(sql, params)).rows.length;

test('#1 mesma BET x50 em paralelo: 1 débito, 49 replays, mesmo status e corpo em todas', async () => {
  const wallet = await openWallet(api, '100.00');
  const payload = wagerPayload(wallet, { money: money('10.00') });

  const results = await Promise.all(Array.from({ length: 50 }, () => post(payload)));

  expect(results.every((r) => r.status === 201)).toBe(true);
  const firsts = results.filter((r) => r.body.idempotentReplay === false);
  const replays = results.filter((r) => r.body.idempotentReplay === true);
  expect(firsts).toHaveLength(1);
  expect(replays).toHaveLength(49);
  const original = firsts[0]?.body;
  for (const replay of replays) expect(replay.body).toEqual({ ...original, idempotentReplay: true });

  expect(await countBy('select 1 from wager_transactions where external_transaction_id = $1', [payload.externalTransactionId])).toBe(1);
  expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 }); // OPENING + 1 débito
});

test('#2 duas BETs de 80,00 em saldo 100,00: 1 PROCESSED, 1 REJECTED, saldo 20,00, 1 débito (10 rodadas)', async () => {
  for (let round = 0; round < 10; round += 1) {
    const wallet = await openWallet(api, '100.00');
    const results = await Promise.all([post(wagerPayload(wallet, { money: money('80.00') })), post(wagerPayload(wallet, { money: money('80.00') }))]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '20.00', rebuilt: '20.00', entries: 2 });
    const { rows } = await probe.query<{ status: string }>('select status from wager_transactions where wallet_id = $1 and kind = $2 order by status', [wallet.walletId, 'BET']);
    expect(rows.map((r) => r.status)).toEqual(['PROCESSED', 'REJECTED']);
  }
});

test('30 BETs distintas de 10,00 em saldo 100,00: exatamente 10 processadas, 20 rejeitadas, saldo 0,00 (nunca negativo)', async () => {
  const wallet = await openWallet(api, '100.00');
  const results = await Promise.all(Array.from({ length: 30 }, () => post(wagerPayload(wallet, { money: money('10.00') }))));

  expect(results.filter((r) => r.status === 201)).toHaveLength(10);
  expect(results.filter((r) => r.status === 422)).toHaveLength(20);
  expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '0.00', rebuilt: '0.00', entries: 11 });
});

describe('#3 wallets distintas em paralelo', () => {
  test('50 wallets x (BET + WIN + LOSS simultâneas): todas corretas, nenhuma falha transitória', async () => {
    const wallets = await Promise.all(Array.from({ length: 50 }, () => openWallet(api, '100.00')));
    const requests = wallets.flatMap((wallet) => [
      post(wagerPayload(wallet, { kind: 'BET', money: money('10.00') })),
      post(wagerPayload(wallet, { kind: 'WIN', money: money('25.00') })),
      post(wagerPayload(wallet, { kind: 'LOSS', money: money('5.00') })),
    ]);

    const results = await Promise.all(requests);

    expect(results.every((r) => r.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '115.00', rebuilt: '115.00', entries: 3 });
    }
  });
});
