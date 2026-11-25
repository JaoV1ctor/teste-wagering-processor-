// Disponibilidade sob contenção. Não é teste de volume: prova o comportamento com uma wallet travada e registra o que NÃO protege o serviço.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type pg from 'pg';
import type { Api } from '../support/app';
import { ledgerBalance } from '../support/db';
import { type Isolated, postJson, securityCategory, send, startIsolated, tally } from '../support/security';
import { waitFor } from '../support/sqs';
import { openWallet, wagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(9, 'Disponibilidade');
let env: Isolated;

beforeAll(async () => {
  env = await startIsolated({ LOCK_TIMEOUT_MS: '300' });
});
afterAll(async () => {
  write();
  await env.close();
});

const submit = (api: Api, wallet: { walletId: string; playerId: string }) =>
  postJson(api, '/wagering/transactions', wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } }), { 'idempotency-key': `k-${uuid()}` });

/** Uma transação alheia segura o lock da wallet enquanto `work` roda: uma "dona travada". */
async function whileLocked<T>(walletId: string, work: (holder: pg.PoolClient) => Promise<T>): Promise<T> {
  const holder = await env.probe.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('select id from wallets where id = $1 for no key update', [walletId]);
    return await work(holder);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
}

securityCase('Wallet travada: a submissão não fica pendurada', '503 com Retry-After em poucos segundos; nada gravado; depois 201', async () => {
  const wallet = await openWallet(env.api, '100.00');
  const { replies, elapsed } = await whileLocked(wallet.walletId, async () => {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(env.api, wallet)));
    return { replies: results, elapsed: performance.now() - started };
  });
  expect(replies.map((r) => r.status)).toEqual(Array(8).fill(503));
  expect(replies.every((r) => r.headers.get('retry-after') === '1')).toBe(true);
  expect(elapsed).toBeLessThan(10_000);
  expect(await ledgerBalance(env.probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  expect((await submit(env.api, wallet)).status).toBe(201);
  return `${tally(replies.map((r) => r.status))} com Retry-After: 1 (lock_timeout de 300 ms, 3 tentativas); após liberar, 201`;
});

securityCase('Poucas requisições contra uma wallet travada não derrubam as outras', 'outra wallet responde 201 enquanto a primeira está travada', async () => {
  const [stuck, other] = [await openWallet(env.api, '100.00'), await openWallet(env.api, '100.00')];
  const [reply] = await whileLocked(stuck.walletId, () => Promise.all([submit(env.api, other), submit(env.api, stuck), submit(env.api, stuck)]));
  expect(reply.status).toBe(201);
  return 'outra wallet: 201';
});

securityCase('Uma wallet travada esgota o pool e atrasa TODAS as outras e o readiness', 'comportamento atual: outra wallet só responde quando uma conexão é liberada; /health/ready vira 503', async () => {
  const slow = await env.startAnother({ LOCK_TIMEOUT_MS: '8000' });
  const [stuck, other] = [await openWallet(slow, '100.00'), await openWallet(slow, '100.00')];
  const observed = await whileLocked(stuck.walletId, async (holder) => {
    const queued = Promise.all(Array.from({ length: 30 }, () => submit(slow, stuck)));
    let waiting = 0;
    await waitFor('conexões da aplicação presas no lock', async () => {
      const { rows } = await env.probe.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      waiting = rows[0]!.n;
      return waiting >= 10;
    });
    let answered = false;
    const bystander = submit(slow, other).then((reply) => { answered = true; return reply; });
    const ready = await send(slow, 'GET', '/health/ready');
    const blockedWhileLocked = !answered;
    await holder.query('ROLLBACK'); // libera: as presas e a da outra wallet seguem
    return { waiting, ready: ready.status, blockedWhileLocked, bystander: await bystander, queued: await queued };
  });
  expect(observed.blockedWhileLocked).toBe(true);
  expect(observed.ready).toBe(503);
  expect(observed.bystander.status).toBe(201);
  expect(observed.queued.every((r) => r.status === 201)).toBe(true);
  return `30 requisições numa wallet travada: ${observed.waiting} conexões presas; outra wallet sem resposta até a liberação (depois 201); ready ${observed.ready}`;
}, 'limitação');

securityCase('Não há rate limiting', 'comportamento atual: 500 requisições seguidas de um mesmo chamador, nenhuma 429', async () => {
  const wallet = await openWallet(env.api, '100.00');
  const statuses: number[] = [];
  for (let batch = 0; batch < 20; batch += 1) {
    statuses.push(...(await Promise.all(Array.from({ length: 25 }, () => send(env.api, 'GET', `/wallets/${wallet.walletId}`)))).map((r) => r.status));
  }
  expect(statuses.filter((status) => status === 429)).toEqual([]);
  return `${tally(statuses)}; nenhuma limitação por origem, provedor ou rota`;
}, 'limitação');

securityCase('Corpos grandes repetidos não derrubam o serviço', '413 em todos e health 200 em seguida', async () => {
  const body = JSON.stringify({ x: 'a'.repeat(5_000_000) });
  const statuses = (await Promise.all(Array.from({ length: 20 }, () => postJson(env.api, '/wallets', body)))).map((r) => r.status);
  expect(statuses).toEqual(Array(20).fill(413));
  expect((await send(env.api, 'GET', '/health/ready')).status).toBe(200);
  return `20 corpos de 5 MB: ${tally(statuses)}; ready 200`;
});
