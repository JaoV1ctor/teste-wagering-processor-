// Abuso do corpo e do protocolo HTTP: tamanho, sintaxe, aninhamento, tipo de conteúdo, chaves especiais e métodos inesperados.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import {
  type Attempt, expectRejected, type Isolated, leaksIn, postJson, securityCategory, send, sendRawHttp, snapshot, startIsolated, tally,
} from '../support/security';
import { openWallet, wagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(3, 'Abuso de corpo e protocolo');
let env: Isolated;
let wallet: { walletId: string; playerId: string };

beforeAll(async () => {
  env = await startIsolated();
  wallet = await openWallet(env.api, '100.00');
});
afterAll(async () => {
  write();
  await env.close();
});

const PATHS = ['/wallets', '/wagering/transactions'];
const walletBody = () => ({ playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } });
const onBothPosts = (cases: readonly (readonly [string, string | Uint8Array, Record<string, string>?])[]): Attempt[] =>
  PATHS.flatMap((path) => cases.map(([label, body, headers]): Attempt =>
    [`${path} ${label}`, () => send(env.api, 'POST', path, body, { 'content-type': 'application/json', 'idempotency-key': `k-${uuid()}`, ...headers })]));

securityCase('Corpo gigante (200 KB a 20 MB)', '413; banco inalterado', () =>
  expectRejected(env.probe, onBothPosts([200_000, 2_000_000, 20_000_000].map((n) => [`${n} bytes`, JSON.stringify({ x: 'a'.repeat(n) })] as const)), [413]));

securityCase('Corpo comprimido que expande além do limite (gzip)', '413: o limite vale para o corpo descomprimido', () => {
  const bomb = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ x: 'a'.repeat(20_000_000) })));
  return expectRejected(env.probe, onBothPosts([[`${bomb.length} bytes comprimidos, 20 MB abertos`, bomb, { 'content-encoding': 'gzip' }]]), [413]);
});

securityCase('Codificação ou charset desconhecidos e gzip corrompido', '400 ou 415; banco inalterado', () =>
  expectRejected(env.probe, onBothPosts([
    ['content-encoding inventado', '{}', { 'content-encoding': 'xyz' }], ['gzip corrompido', 'isto não é gzip', { 'content-encoding': 'gzip' }],
    ['charset latin9', '{}', { 'content-type': 'application/json; charset=latin9' }],
  ]), [400, 415]));

securityCase('JSON inválido ou truncado', '400; banco inalterado', () =>
  expectRejected(env.probe, onBothPosts(['', '{', '}', '{"playerId": ', "{'a':1}", '{"a":1,}', '[1,2', 'undefined', '{"a":01}', '\u0000{}', '{}{}', '<xml/>']
    .map((body) => [JSON.stringify(body), body] as const))));

securityCase('Primitivo ou array no lugar do objeto', '400; banco inalterado', () =>
  expectRejected(env.probe, onBothPosts(['"texto"', '42', 'true', 'null', '[]', '[{}]', JSON.stringify([walletBody()]), JSON.stringify([wagerPayload({ walletId: uuid(), playerId: uuid() })])]
    .map((body) => [body.slice(0, 30), body] as const))));

securityCase('JSON muito aninhado (até o limite de tamanho)', '400 (nunca 500 nem processo derrubado); o serviço segue respondendo', async () => {
  const deep = [
    ['40 000 arrays', '['.repeat(40_000) + ']'.repeat(40_000)],
    ['15 000 objetos', `${'{"a":'.repeat(15_000)}1${'}'.repeat(15_000)}`],
    ['aninhado dentro de money', JSON.stringify({ ...walletBody(), initialBalance: '__X__' }).replace('"__X__"', `${'['.repeat(30_000)}${']'.repeat(30_000)}`)],
    ['sem fechar', '['.repeat(90_000)],
  ] as const;
  const summary = await expectRejected(env.probe, onBothPosts(deep));
  expect((await send(env.api, 'GET', '/health/live')).status).toBe(200);
  return summary;
});

securityCase('Content-Type ausente, textual, XML ou multipart', '400 ou 415; banco inalterado', () =>
  expectRejected(env.probe, PATHS.flatMap((path) => ['text/plain', 'application/xml', 'multipart/form-data; boundary=x', 'application/octet-stream', 'text/json', ''].map((type): Attempt =>
    [`${path} ${type}`, () => send(env.api, 'POST', path, new TextEncoder().encode(JSON.stringify(walletBody())), {
      'idempotency-key': `k-${uuid()}`, ...(type === '' ? {} : { 'content-type': type }),
    })])), [400, 415]));

securityCase('Chaves "__proto__", "constructor" e "prototype"', '400 (campo desconhecido); nenhum protótipo poluído', async () => {
  const base = JSON.stringify(walletBody());
  const inject = (member: string) => `{${member},${base.slice(1)}`;
  const insideMoney = (member: string) => base.replace('"amount"', `${member},"amount"`);
  const members = ['"__proto__":{"polluted":"yes"}', '"constructor":{"prototype":{"polluted":"yes"}}', '"prototype":{"polluted":"yes"}', '"__proto__":null', '"toString":"x"'];
  const summary = await expectRejected(env.probe, members.flatMap((member): Attempt[] => [
    [`topo ${member}`, () => postJson(env.api, '/wallets', inject(member))],
    [`money ${member}`, () => postJson(env.api, '/wallets', insideMoney(member))],
    [`aposta ${member}`, () => postJson(env.api, '/wagering/transactions', JSON.stringify(wagerPayload(wallet)).replace('{', `{${member},`), { 'idempotency-key': `k-${uuid()}` })],
  ]));
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  return `${summary}; Object.prototype intacto`;
});

securityCase('Parâmetros de consulta repetidos ou em forma de objeto', '400; banco inalterado', () =>
  expectRejected(env.probe, ['limit=1&limit=2', 'limit[]=1', 'limit[a]=1', 'cursor=a&cursor=b', 'extra=1', '__proto__[x]=1', 'limit=0', 'limit=-1', 'limit=1e3'].map((query): Attempt =>
    [query, () => send(env.api, 'GET', `/wallets/${wallet.walletId}/ledger?${query}`)])));

securityCase('Métodos HTTP não previstos (nenhuma rota apaga nem altera)', '404; banco inalterado', () =>
  expectRejected(env.probe, [`/wallets`, `/wallets/${wallet.walletId}`, `/wallets/${wallet.walletId}/ledger`, '/wagering/transactions', '/health/live', '/metrics']
    .flatMap((path) => ['PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method): Attempt => [`${method} ${path}`, () => send(env.api, method, path)])), [404]));

securityCase('TRACE, CONNECT e métodos inventados (bytes crus)', '400 ou 404, sem eco da requisição; banco inalterado', async () => {
  const before = await snapshot(env.probe);
  const statuses: string[] = [];
  for (const method of ['TRACE', 'FOO', 'DEL ETE', 'GET\tx']) {
    const response = await sendRawHttp(env.api, `${method} /wallets HTTP/1.1\r\nHost: x\r\nX-Echo: marca-trace\r\nConnection: close\r\n\r\n`);
    statuses.push(response.split(' ')[1] ?? 'fechado');
    expect(response).not.toContain('marca-trace');
    expect(leaksIn(response)).toEqual([]);
  }
  expect(statuses.filter((status) => status !== '400' && status !== '404')).toEqual([]);
  expect(await snapshot(env.probe)).toEqual(before);
  return tally(statuses);
});

securityCase('Codificação percentual malformada na URL', '400 em JSON, sem stack trace', () =>
  expectRejected(env.probe, ['/wallets/%E0%A4%A', '/wallets/%', '/wallets/%ZZ', '/providers/%/wagering/transactions/%C0%AF', '/wagering/transactions/%u0000'].map((path): Attempt =>
    [path, () => send(env.api, 'GET', path)]), [400, 404]));

securityCase('Travessia de caminho na URL', '400 ou 404; nenhum arquivo do servidor exposto', () =>
  expectRejected(env.probe, ['/..%2f..%2fetc%2fpasswd', '/wallets/..%2f..%2f.env', '/health/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/.env', '/.env', '/.git/config'].map((path): Attempt =>
    [path, () => send(env.api, 'GET', path)]), [400, 404]));
