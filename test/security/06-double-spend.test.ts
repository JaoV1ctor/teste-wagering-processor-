// Gasto duplo: requisições paralelas com chaves DIFERENTES contra um saldo que só comporta uma. Banco real, uma e duas instâncias.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { Api } from '../support/app';
import { ledgerBalance } from '../support/db';
import { type Isolated, postJson, securityCategory, startIsolated, tally } from '../support/security';
import { openWallet, reversalPayload, wagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(6, 'Gasto duplo');
let env: Isolated;
let second: Api;

beforeAll(async () => {
  env = await startIsolated();
  second = await env.startAnother();
});
afterAll(async () => {
  write();
  await env.close();
});

const submit = (api: Api, payload: unknown) => postJson(api, '/wagering/transactions', payload, { 'idempotency-key': `k-${uuid()}` });
const money = (amount: string) => ({ amount, currency: 'BRL' });
const negatives = async () =>
  (await env.probe.query('select 1 from wallets where balance < 0 union all select 1 from wallet_ledger_entries where balance_after < 0')).rows.length;

/** 50 apostas distintas do saldo inteiro, em rodízio entre `apis`: exatamente uma aceita. */
async function race(apis: () => Api[]): Promise<string> {
  const outcomes: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const wallet = await openWallet(env.api, '80.00');
    const targets = apis();
    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(targets[i % targets.length]!, wagerPayload(wallet, { money: money('80.00') }))));
    const statuses = replies.map((reply) => reply.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 422)).toHaveLength(49);
    expect(replies.filter((r) => r.status === 422).every((r) => r.text.includes('INSUFFICIENT_BALANCE'))).toBe(true);
    expect(await ledgerBalance(env.probe, wallet.walletId)).toEqual({ stored: '0.00', rebuilt: '0.00', entries: 2 });
    outcomes.push(...statuses);
  }
  expect(await negatives()).toBe(0);
  return `3 rodadas de 50: ${tally(outcomes)}; saldo 0.00, 1 débito por wallet, nenhum saldo negativo`;
}

securityCase('50 apostas paralelas, chaves diferentes, saldo para uma só (uma instância)', 'exatamente 1 aceita e 49 INSUFFICIENT_BALANCE', () => race(() => [env.api]));

securityCase('O mesmo distribuído entre duas instâncias', 'exatamente 1 aceita; a garantia vem do banco', () => race(() => [env.api, second]));

securityCase('50 estornos paralelos da mesma aposta, ids e chaves diferentes', 'exatamente 1 crédito; 49 ALREADY_REVERSED', async () => {
  const wallet = await openWallet(env.api, '80.00');
  const bet = wagerPayload(wallet, { money: money('80.00') });
  expect((await submit(env.api, bet)).status).toBe(201);
  const replies = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    submit([env.api, second][i % 2]!, reversalPayload(wallet, bet, i % 3 === 0 ? 'ROLLBACK' : 'REFUND'))));
  expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
  expect(replies.filter((r) => r.status === 422 && r.text.includes('ALREADY_REVERSED'))).toHaveLength(49);
  expect(await ledgerBalance(env.probe, wallet.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 3 });
  return `${tally(replies.map((r) => r.status))}; saldo 80.00 com um único crédito`;
});

securityCase('Estorno disputando com novas apostas do mesmo dinheiro', 'o saldo nunca fica negativo e fecha com o ledger', async () => {
  const wallet = await openWallet(env.api, '80.00');
  const bet = wagerPayload(wallet, { money: money('80.00') });
  await submit(env.api, bet);
  const replies = await Promise.all([
    submit(env.api, reversalPayload(wallet, bet, 'REFUND')),
    ...Array.from({ length: 30 }, (_, i) => submit([env.api, second][i % 2]!, wagerPayload(wallet, { money: money('80.00') }))),
  ]);
  const balance = await ledgerBalance(env.probe, wallet.walletId);
  expect(balance.stored).toBe(balance.rebuilt);
  expect(replies.filter((r) => r.status === 201).length).toBeLessThanOrEqual(2); // o estorno e, no máximo, uma aposta
  expect(replies.every((r) => r.status === 201 || r.status === 422)).toBe(true);
  expect(await negatives()).toBe(0);
  return `${tally(replies.map((r) => r.status))}; saldo igual ao ledger, nunca negativo`;
});
