// GET /health/live e /health/ready (SPEC §8.4; README §9). Aplicação real; as dependências "fora do ar" são endereços mortos de verdade
// (porta 9, recusa de conexão), nunca um mock. Ninguém derruba o Postgres/MiniStack compartilhados.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Api, startApi } from '../support/app';
import { ensureSchema } from '../support/db';

const DEAD_POSTGRES = 'postgres://wager:wager@127.0.0.1:9/wager';
const DEAD_SQS = 'http://127.0.0.1:9';
/** Folga sobre o timeout curto do readiness (2 s por padrão): a resposta nunca pode ficar pendurada. */
const MAX_READY_MS = 4000;

let healthy: Api;
const opened: Api[] = [];

beforeAll(async () => {
  await ensureSchema();
  healthy = await startApi();
  opened.push(healthy);
});
afterAll(async () => {
  for (const api of opened) await api.close();
});

async function timed(api: Api, path: string) {
  const started = Date.now();
  const res = await api.call('GET', path);
  return { ...res, ms: Date.now() - started };
}

describe('GET /health/live', () => {
  test('200 sem autenticação, só diz que o processo responde', async () => {
    const res = await healthy.call('GET', '/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('continua 200 com Postgres e SQS fora do ar (liveness não olha dependências)', async () => {
    const broken = await startApi({ DATABASE_URL: DEAD_POSTGRES, AWS_ENDPOINT_URL: DEAD_SQS });
    opened.push(broken);
    expect((await broken.call('GET', '/health/live')).status).toBe(200);
  });
});

describe('GET /health/ready', () => {
  test('200 com Postgres e SQS alcançáveis, sem autenticação', async () => {
    const res = await healthy.call('GET', '/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('SQS indisponível: 503 apontando sqs down e postgres up, dentro do timeout curto', async () => {
    const api = await startApi({ AWS_ENDPOINT_URL: DEAD_SQS });
    opened.push(api);
    const res = await timed(api, '/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
    expect(res.ms).toBeLessThan(MAX_READY_MS);
  });

  test('Postgres indisponível: 503 apontando postgres down e sqs up, dentro do timeout curto', async () => {
    const api = await startApi({ DATABASE_URL: DEAD_POSTGRES });
    opened.push(api);
    const res = await timed(api, '/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
    expect(res.ms).toBeLessThan(MAX_READY_MS);
  });

  test('os dois fora do ar: 503 com os dois down', async () => {
    const api = await startApi({ DATABASE_URL: DEAD_POSTGRES, AWS_ENDPOINT_URL: DEAD_SQS });
    opened.push(api);
    const res = await timed(api, '/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'down' } });
    expect(res.ms).toBeLessThan(MAX_READY_MS);
  });

  test('a resposta de falha não vaza detalhe interno (endereço, mensagem de erro)', async () => {
    const api = await startApi({ DATABASE_URL: DEAD_POSTGRES, AWS_ENDPOINT_URL: DEAD_SQS });
    opened.push(api);
    const res = await api.call('GET', '/health/ready');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('ECONNREFUSED');
  });
});
