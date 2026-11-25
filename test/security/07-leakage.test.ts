// Vazamento de informação: respostas de erro, logs capturados durante ataques, /metrics, /health e cabeçalhos.
import { afterAll, beforeAll, expect, spyOn } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { captureLogs } from '../support/logs';
import { type Isolated, leaksIn, postJson, type Reply, SECRET_CANARY, securityCategory, send, startIsolated, tally } from '../support/security';
import { openWallet, wagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(7, 'Vazamento de informação');
let env: Isolated;

beforeAll(async () => {
  env = await startIsolated();
});
afterAll(async () => {
  write();
  await env.close();
});

/** Dados do chamador que não podem ir para o log nem para /metrics (o log registra providerId, walletId, transactionId e correlationId). */
async function marked() {
  const wallet = await openWallet(env.api, '98765.43');
  const payload = wagerPayload(wallet, {
    externalTransactionId: `marca-ext-${uuid()}`, roundId: `marca-rodada-${uuid()}`, gameId: `marca-jogo-${uuid()}`, money: { amount: '4321.09', currency: 'BRL' },
  });
  const key = `marca-chave-${uuid()}`;
  const canaries = [payload.externalTransactionId, payload.roundId, payload.gameId, key, wallet.playerId, '4321.09', '98765.43', '94444.34'];
  return { wallet, payload, key, canaries };
}

const leaksOf = (replies: readonly Reply[]) => replies.flatMap((reply) => leaksIn(reply.text).map((leak) => `${reply.status}: ${leak}`));

securityCase('Corpos de erro 400, 404, 409, 413, 415 e 422', 'só code, message e, na validação, details; sem stack, SQL ou credencial', async () => {
  const { payload, key } = await marked();
  const submit = (body: unknown, k = key, headers: Record<string, string> = {}) => postJson(env.api, '/wagering/transactions', body, { 'idempotency-key': k, ...headers });
  await submit(payload);
  const replies = [
    await submit('{'), await submit({}), await send(env.api, 'GET', `/wallets/${uuid()}`), await send(env.api, 'GET', '/wagering/transactions/x'),
    await send(env.api, 'GET', `/wagering/transactions/${uuid()}`), await submit({ ...payload, walletId: uuid() }, `k-${uuid()}`),
    await submit({ ...payload, roundId: 'outro' }), await submit('x'.repeat(200_000)), await submit('{}', key, { 'content-encoding': 'xyz' }),
    await submit({ ...payload, externalTransactionId: `e-${uuid()}`, money: { amount: '999999.00', currency: 'BRL' } }, `k-${uuid()}`),
    await postJson(env.api, '/wallets', { playerId: payload.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }),
  ];
  expect(leaksOf(replies)).toEqual([]);
  for (const reply of replies.filter((r) => r.status !== 422)) {
    expect(Object.keys(JSON.parse(reply.text) as object).filter((k) => !['code', 'message', 'details'].includes(k))).toEqual([]);
  }
  return `${tally(replies.map((r) => r.status))}; nenhum detalhe interno`;
});

securityCase('Erro interno inesperado com segredos na mensagem da exceção', '500 genérico; nem resposta nem log levam a mensagem', async () => {
  const { payload } = await marked();
  const secret = `select * from wallets; postgres://wager:wager@db/wager ${SECRET_CANARY} ${payload.roundId}`;
  const spy = spyOn(env.api.app.get(ProcessWagerTransactionUseCase), 'execute').mockImplementation(async () => {
    throw new Error(secret);
  });
  const logs = captureLogs();
  let reply: Reply;
  let output: string;
  try {
    reply = await postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': `k-${uuid()}` });
    output = logs.lines().map((line) => line.raw).join('\n');
    expect(logs.named('request_failed')).toHaveLength(1);
  } finally {
    logs.restore();
    spy.mockRestore();
  }
  expect(reply.status).toBe(500);
  expect(JSON.parse(reply.text)).toEqual({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
  expect(leaksIn(output).filter((leak) => leak !== 'caminho do servidor')).toEqual([]);
  expect(output).not.toContain(payload.roundId);
  return '500 INTERNAL_ERROR; log com a classe do erro, sem a mensagem';
});

securityCase('Banco inacessível, com senha na string de conexão', '503 com Retry-After; sem endereço nem credencial em resposta ou log', async () => {
  const logs = captureLogs();
  const replies: Reply[] = [];
  let output: string;
  try {
    const dead = await env.startAnother({ DATABASE_URL: 'postgres://wager:sec-canary-db-password@127.0.0.1:9/wager' });
    replies.push(await postJson(dead, '/wagering/transactions', wagerPayload({ walletId: uuid(), playerId: uuid() }), { 'idempotency-key': 'k' }));
    replies.push(await send(dead, 'GET', `/wallets/${uuid()}`), await send(dead, 'GET', '/health/ready'));
    output = logs.lines().map((line) => line.raw).join('\n');
  } finally {
    logs.restore();
  }
  expect(replies.map((r) => r.status)).toEqual([503, 503, 503]);
  expect(replies[0]!.headers.get('retry-after')).toBe('1');
  expect(leaksOf(replies)).toEqual([]);
  for (const text of [...replies.map((r) => r.text), output]) expect(text).not.toMatch(/sec-canary|127\.0\.0\.1:9|postgres:\/\//);
  return `${tally(replies.map((r) => r.status))}; sem host, porta ou senha`;
});

securityCase('Logs durante uma rajada de ataques', 'uma linha JSON por evento; sem corpo, valores, chave, playerId, rodada, jogo ou segredos', async () => {
  const { wallet, payload, key, canaries } = await marked();
  const logs = captureLogs();
  const replies: Reply[] = [];
  let lines: string[];
  try {
    const submit = (body: unknown, k: string) => postJson(env.api, '/wagering/transactions', body, { 'idempotency-key': k });
    replies.push(await submit(payload, key), await submit(payload, key), await submit({ ...payload, roundId: `${payload.roundId}-x` }, key));
    replies.push(await submit({ ...payload, surprise: canaries.join(' ') }, key), await submit(`{"roundId":"${payload.roundId}"`, key));
    replies.push(await submit({ ...payload, money: { amount: '4321.091', currency: 'BRL' } }, key), await submit({ ...payload, externalTransactionId: `${payload.externalTransactionId}'; --`, kind: 'WIN' }, `${key}-2`));
    replies.push(await send(env.api, 'POST', `/wallets/${wallet.walletId}/reconciliation`));
    lines = logs.lines().map((line) => line.raw); // lança se alguma linha não for JSON
  } finally {
    logs.restore();
  }
  const output = lines.join('\n');
  expect(canaries.filter((value) => output.includes(value))).toEqual([]);
  expect(output).not.toContain(SECRET_CANARY);
  expect(output).not.toMatch(/postgres:\/\/|:wager@/);
  return `${replies.length} requisições (${tally(replies.map((r) => r.status))}), ${lines.length} linhas de log; nenhuma das ${canaries.length} marcas`;
});

securityCase('/metrics e /health sem dado de cliente', 'nenhum id, marca, valor ou segredo; rótulos só de status, tipo e origem', async () => {
  const { wallet, payload, key, canaries } = await marked();
  await postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': key });
  const metrics = await (await fetch(`${env.api.url}/metrics`)).text();
  const health = [await send(env.api, 'GET', '/health/live'), await send(env.api, 'GET', '/health/ready')];
  const everything = [metrics, ...health.map((r) => r.text)].join('\n');
  const forbidden = [...canaries, wallet.walletId, payload.providerId, SECRET_CANARY, 'postgres://'];
  expect(forbidden.filter((value) => everything.includes(value))).toEqual([]);
  expect(everything).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  const labels = new Set([...metrics.matchAll(/[{,](\w+)="/g)].map((match) => match[1]!));
  expect([...labels].filter((label) => !['status', 'kind', 'source', 'le'].includes(label))).toEqual([]);
  return `rótulos: ${[...labels].sort().join(', ')}; health: ${health.map((r) => r.text).join(' ')}`;
});

securityCase('Rota inexistente', '404 em JSON, sem banner nem página do framework', async () => {
  const replies: Reply[] = [];
  for (const path of ['/', '/admin', '/api', '/swagger', '/.well-known/security.txt', '/actuator/env', '/debug/pprof']) replies.push(await send(env.api, 'GET', path));
  for (const reply of replies) {
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.text)).toEqual({ code: 'NOT_FOUND', message: 'Recurso não encontrado' });
    expect(reply.text).not.toMatch(/Cannot |Express|Nest|<html/i);
  }
  return `${tally(replies.map((r) => r.status))}; corpo fixo`;
});

securityCase('Cabeçalho que anuncia o framework', 'sem X-Powered-By nem Server, em respostas de sucesso, erro e rota inexistente', async () => {
  const replies = [
    await send(env.api, 'GET', '/health/live'), await send(env.api, 'GET', '/nao-existe'), await send(env.api, 'GET', '/wallets/x'),
    await postJson(env.api, '/wallets', '{'), await send(env.api, 'OPTIONS', '/wallets'),
  ];
  expect(replies.flatMap((r) => [r.headers.get('x-powered-by'), r.headers.get('server')]).filter((value) => value !== null)).toEqual([]);
  return `${tally(replies.map((r) => r.status))}; sem X-Powered-By e sem Server`;
});

securityCase('Sem cabeçalho CORS: página de outra origem não lê respostas', 'nenhum Access-Control-Allow-Origin', async () => {
  const replies = [
    await send(env.api, 'GET', '/health/live', undefined, { origin: 'https://atacante.example' }),
    await send(env.api, 'OPTIONS', '/wagering/transactions', undefined, { origin: 'https://atacante.example', 'access-control-request-method': 'POST' }),
  ];
  expect(replies.map((r) => r.headers.get('access-control-allow-origin'))).toEqual([null, null]);
  return `sem Access-Control-Allow-Origin (${tally(replies.map((r) => r.status))})`;
});

securityCase('Cabeçalhos de endurecimento ausentes', 'comportamento atual: sem HSTS, X-Content-Type-Options ou Cache-Control', async () => {
  const reply = await send(env.api, 'GET', `/wallets/${uuid()}`);
  const missing = ['strict-transport-security', 'x-content-type-options', 'cache-control'].filter((name) => reply.headers.get(name) === null);
  expect(missing).toEqual(['strict-transport-security', 'x-content-type-options', 'cache-control']);
  return `ausentes: ${missing.join(', ')}`;
}, 'limitação');
