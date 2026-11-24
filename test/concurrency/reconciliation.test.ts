// A reconciliação roda SEM lock da wallet e lê saldo e ledger numa única instrução (um snapshot): com apostas concorrentes na mesma wallet
// ela nunca pode ver uma divergência que não existe. Postgres REAL, aplicação real, paralelismo real.
import { afterAll, beforeAll, expect, test } from 'bun:test';
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

test('40 apostas paralelas na mesma wallet enquanto se reconcilia sem parar: toda leitura é consistente e a final fecha com o ledger', async () => {
  const wallet = await openWallet(api, '1000.00');
  const bets = Array.from({ length: 40 }, () => wagerPayload(wallet, { money: { amount: '10.00', currency: 'BRL' } }));

  let running = true;
  const observed: { consistent: boolean; checkedEntries: number }[] = [];
  const reconciling = (async () => {
    while (running) {
      const res = await api.call('POST', `/wallets/${wallet.walletId}/reconciliation`);
      expect(res.status).toBe(200);
      observed.push({ consistent: res.body.consistent, checkedEntries: res.body.checkedEntries });
    }
  })();

  const responses = await Promise.all(bets.map((bet) => submit(api, bet, defaultKey(bet))));
  running = false;
  await reconciling;

  expect(responses.every((res) => res.status === 201)).toBe(true);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.filter((o) => !o.consistent)).toEqual([]);

  const final = await api.call('POST', `/wallets/${wallet.walletId}/reconciliation`);
  expect(final.body).toMatchObject({ consistent: true, storedBalance: { amount: '600.00' }, calculatedBalance: { amount: '600.00' }, checkedEntries: 41 });
  expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '600.00', rebuilt: '600.00', entries: 41 });
});
