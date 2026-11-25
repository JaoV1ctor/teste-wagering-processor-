// Disputa pela mesma Idempotency-Key: entre provedores não há disputa; dentro de um provedor há um único efeito. Duas instâncias da
// aplicação sobre o mesmo Postgres real, requisições HTTP simultâneas.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { openWallet, submit, wagerPayload } from '../support/wager';

const probe = createProbe(4);
let apis: Api[];

beforeAll(async () => {
  await ensureSchema();
  apis = [await startApi(), await startApi()];
});
afterAll(async () => {
  await Promise.all(apis.map((api) => api.close()));
  await probe.end();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });
const via = (index: number) => apis[index % apis.length]!;
const countKey = async (providerId: string, key: string) =>
  (await probe.query('select 1 from wager_transactions where provider_id = $1 and idempotency_key = $2', [providerId, key])).rows.length;

test('dois provedores, mesma chave, cada um 25x em paralelo: uma transação por provedor, 24 replays cada, nenhum 409 (5 rodadas)', async () => {
  for (let round = 0; round < 5; round += 1) {
    const wallets = [await openWallet(apis[0]!, '100.00'), await openWallet(apis[0]!, '100.00')];
    const key = `disputa-${uuid()}`;
    const payloads = wallets.map((wallet, i) => wagerPayload(wallet, { providerId: `p${i}-${uuid()}`, money: money('10.00') }));

    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(via(Math.floor(i / 2)), payloads[i % 2], key)));

    expect(replies.map((r) => r.status)).toEqual(Array(50).fill(201));
    for (const side of [0, 1]) {
      const own = replies.filter((_, i) => i % 2 === side);
      expect(own.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
      expect(new Set(own.map((r) => r.body.transactionId)).size).toBe(1);
      expect(await countKey(payloads[side]!.providerId, key)).toBe(1);
      expect(await ledgerBalance(probe, wallets[side]!.walletId)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
    }
    expect(replies[0]!.body.transactionId).not.toBe(replies[1]!.body.transactionId);
  }
});

test('dois provedores com a mesma chave na MESMA wallet, em paralelo: dois efeitos, um por provedor', async () => {
  const wallet = await openWallet(apis[0]!, '100.00');
  const key = `disputa-${uuid()}`;
  const payloads = [0, 1].map((i) => wagerPayload(wallet, { providerId: `p${i}-${uuid()}`, money: money('10.00') }));

  const replies = await Promise.all(Array.from({ length: 40 }, (_, i) => submit(via(Math.floor(i / 2)), payloads[i % 2], key)));

  expect(replies.every((r) => r.status === 201)).toBe(true);
  expect(replies.filter((r) => r.body.idempotentReplay === false)).toHaveLength(2);
  expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 3 });
});

test('mesmo provedor e chave com payloads diferentes em wallets diferentes, em paralelo: um efeito e um 409, nunca 500 (30 rodadas)', async () => {
  for (let round = 0; round < 30; round += 1) {
    const wallets = [await openWallet(apis[0]!, '100.00'), await openWallet(apis[0]!, '100.00')];
    const providerId = `p-${uuid()}`;
    const key = `disputa-${uuid()}`;
    // Metade das rodadas repete também o id externo: disputam as DUAS constraints de unicidade ao mesmo tempo.
    const externalTransactionId = `ext-${uuid()}`;
    const payloads = wallets.map((wallet, i) =>
      wagerPayload(wallet, { providerId, money: money('10.00'), ...(round % 2 === 0 ? { externalTransactionId } : { externalTransactionId: `${externalTransactionId}-${i}` }) }));

    const replies = await Promise.all(payloads.map((payload, i) => submit(via(i), payload, key)));

    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await countKey(providerId, key)).toBe(1);
    const balances = await Promise.all(wallets.map(async (wallet) => (await ledgerBalance(probe, wallet.walletId)).stored));
    expect(balances.sort()).toEqual(['100.00', '90.00']);
  }
});
