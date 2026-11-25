// Injeção e entradas malformadas em todos os campos de texto, cabeçalhos e ids de rota. Aplicação real, banco e filas isolados.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { captureLogs } from '../support/logs';
import { type Attempt, expectRejected, type Isolated, leaksIn, postJson, type Reply, securityCategory, send, sendRawHttp, startIsolated, tally } from '../support/security';
import { openWallet, wagerPayload, type WagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(1, 'Injeção e entradas malformadas');
let env: Isolated;
let wallet: { walletId: string; playerId: string };

beforeAll(async () => {
  env = await startIsolated();
  wallet = await openWallet(env.api, '1000.00');
});
afterAll(async () => {
  write();
  await env.close();
});

const SQL_INJECTIONS = [
  "'; DROP TABLE wallets;--", "' OR '1'='1", '1; SELECT pg_sleep(5)--', "\\'; DELETE FROM wallet_ledger_entries;--", '$1; ?', '%27%20OR%201=1',
  "admin'/*", '{"$ne": null}',
];
const FREE_TEXT = ['providerId', 'externalTransactionId', 'roundId', 'gameId', 'referenceExternalTransactionId'] as const;
type FreeText = (typeof FREE_TEXT)[number];
const COLUMN: Record<FreeText, string> = {
  providerId: 'provider_id', externalTransactionId: 'external_transaction_id', roundId: 'round_id', gameId: 'game_id',
  referenceExternalTransactionId: 'reference_external_transaction_id',
};

/** WIN aceita referência opcional: assim todos os campos de texto cabem no mesmo payload. */
const payloadWith = (field: FreeText, value: string): WagerPayload =>
  wagerPayload(wallet, { kind: field === 'referenceExternalTransactionId' ? 'WIN' : 'BET', money: { amount: '1.00', currency: 'BRL' }, [field]: value });
const submit = (payload: unknown, key = `key-${uuid()}`, headers: Record<string, string> = {}): Promise<Reply> =>
  postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': key, ...headers });

/** O valor foi aceito como DADO: resposta 201 ou 202, sem vazamento, e a coluna guarda exatamente o que foi enviado. */
async function storedLiterally(values: readonly string[]): Promise<string> {
  const statuses: number[] = [];
  const problems: string[] = [];
  for (const field of FREE_TEXT) {
    for (const [index, value] of values.entries()) {
      const unique = field === 'externalTransactionId' ? `${value}#${uuid().slice(0, 8)}` : value;
      const reply = await submit(payloadWith(field, unique));
      statuses.push(reply.status);
      if (reply.status !== 201 && reply.status !== 202) {
        problems.push(`${field}[${index}]: HTTP ${reply.status}`);
        continue;
      }
      for (const leak of leaksIn(reply.text)) problems.push(`${field}[${index}]: vazou ${leak}`);
      const { transactionId } = JSON.parse(reply.text) as { transactionId: string };
      const { rows } = await env.probe.query<{ value: string }>(`select ${COLUMN[field]} as value from wager_transactions where id = $1`, [transactionId]);
      if (rows[0]?.value !== unique) problems.push(`${field}[${index}]: gravado diferente do enviado`);
    }
  }
  expect(problems).toEqual([]);
  const { rows: tables } = await env.probe.query("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('wallets','wallet_ledger_entries','wager_transactions')");
  expect(tables).toEqual([{ n: 3 }]);
  return `${statuses.length} envios: ${tally(statuses)}; valor gravado byte a byte; tabelas intactas`;
}

securityCase('SQL injection em campos de texto livre', 'aceito como dado (201/202) e gravado literalmente; nada executado; nunca 500', () =>
  storedLiterally(SQL_INJECTIONS));

securityCase('SQL injection em campos com formato (UUID, tipo, dinheiro)', '400, sem vazamento, banco inalterado', () =>
  expectRejected(env.probe, SQL_INJECTIONS.flatMap((value) =>
    (['playerId', 'walletId', 'kind', 'amount', 'currency'] as const).map((field): Attempt => {
      const base = wagerPayload(wallet);
      const payload = field === 'amount' || field === 'currency' ? { ...base, money: { ...base.money, [field]: value } } : { ...base, [field]: value };
      // A mensagem de validação de dinheiro repete o valor enviado: é eco da entrada do próprio chamador, registrado à parte.
      return [`${field} ${value}`, () => submit(payload), value];
    })).concat(SQL_INJECTIONS.map((value): Attempt =>
      [`POST /wallets playerId ${value}`, () => postJson(env.api, '/wallets', { playerId: value, initialBalance: { amount: '1.00', currency: 'BRL' } })]))));

securityCase('Mensagem de validação de valor ou moeda repete o texto enviado', '400; o eco vem só da entrada do próprio chamador, em JSON', async () => {
  const marker = 'eco-<script>alert(1)</script>';
  const reply = await submit({ ...wagerPayload(wallet), money: { amount: marker, currency: 'BRL' } });
  expect(reply.status).toBe(400);
  expect(reply.headers.get('content-type')).toContain('application/json');
  expect(reply.text).toContain(marker);
  return `400 em application/json; o valor enviado volta em details[].message`;
}, 'limitação');

securityCase('SQL injection em ids de rota, cursor e limit', '400 ou 404, sem vazamento, banco inalterado', () =>
  expectRejected(env.probe, SQL_INJECTIONS.flatMap((raw) => {
    const value = encodeURIComponent(raw);
    return [
      `/wallets/${value}`, `/wallets/${value}/ledger`, `/wallets/${wallet.walletId}/ledger?cursor=${value}`, `/wallets/${wallet.walletId}/ledger?limit=${value}`,
      `/wagering/transactions/${value}`, `/providers/${value}/wagering/transactions/${value}`,
    ].map((path): [string, () => Promise<Reply>] => [path, () => send(env.api, 'GET', path)]);
  }).concat(SQL_INJECTIONS.map((raw): [string, () => Promise<Reply>] =>
    [`reconciliation ${raw}`, () => send(env.api, 'POST', `/wallets/${encodeURIComponent(raw)}/reconciliation`)])), [400, 404]));

securityCase('SQL injection na Idempotency-Key e no x-correlation-id', 'aceitos como dado (201); chave gravada literalmente', async () => {
  const statuses: number[] = [];
  for (const value of SQL_INJECTIONS) {
    const key = `${value} ${uuid()}`;
    const reply = await submit(wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } }), key, { 'x-correlation-id': value });
    statuses.push(reply.status);
    expect(leaksIn(reply.text)).toEqual([]);
    const { rows } = await env.probe.query('select 1 from wager_transactions where idempotency_key = $1', [key]);
    expect(rows).toHaveLength(1);
  }
  expect(statuses.every((status) => status === 201)).toBe(true);
  return `${statuses.length} envios: ${tally(statuses)}`;
});

securityCase('Unicode incomum válido (emoji, controle de direção, largura zero, combinantes)', 'aceito como dado e gravado exatamente', () =>
  storedLiterally(['🎲💸', 'abc‮cba', 'a​b﻿', 'é ≠ é', '￿', 'linha separadora', 'ＦＵＬＬ']));

securityCase('CR e LF dentro de campos do corpo', 'aceitos como dado; nenhum cabeçalho injetado; logs continuam uma linha JSON por evento', async () => {
  const value = 'x\r\nSet-Cookie: injected=1\r\n\r\n{"level":"error","message":"forjada"}';
  const logs = captureLogs();
  const statuses: number[] = [];
  try {
    for (const field of FREE_TEXT) {
      const reply = await submit(payloadWith(field, field === 'externalTransactionId' ? `${value}${uuid()}` : value));
      statuses.push(reply.status);
      expect(reply.headers.get('set-cookie')).toBeNull();
    }
    const lines = logs.lines(); // lança se alguma linha não for JSON
    expect(lines.filter((line) => line.json['message'] === 'forjada')).toEqual([]);
  } finally {
    logs.restore();
  }
  expect(statuses.every((status) => status === 201 || status === 202)).toBe(true);
  return `${statuses.length} envios: ${tally(statuses)}; sem Set-Cookie; nenhuma linha de log forjada`;
});

securityCase('CR ou LF soltos em cabeçalhos (bytes crus no socket)', '400 do servidor HTTP; nenhum cabeçalho injetado; banco inalterado', async () => {
  const body = JSON.stringify(wagerPayload(wallet));
  const { host } = new URL(env.api.url);
  const attempts = ['a\rSet-Cookie: injected=1', 'a\nSet-Cookie: injected=1', 'a\u0000b'].flatMap((value) =>
    ['idempotency-key', 'x-correlation-id'].map((header) => {
      const other = header === 'idempotency-key' ? '' : 'idempotency-key: k-raw\r\n';
      return `POST /wagering/transactions HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n${other}${header}: ${value}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
    }));
  const before = await env.probe.query('select count(*)::text as n from wager_transactions');
  const statuses: string[] = [];
  for (const request of attempts) {
    const response = await sendRawHttp(env.api, request);
    statuses.push(response.split(' ')[1] ?? 'sem resposta');
    expect(response.toLowerCase()).not.toContain('injected=1');
    expect(leaksIn(response)).toEqual([]);
  }
  expect(statuses.every((status) => status === '400')).toBe(true);
  expect((await env.probe.query('select count(*)::text as n from wager_transactions')).rows).toEqual(before.rows);
  return `${statuses.length} requisições: ${tally(statuses)}; nada gravado`;
});

securityCase('Textos muito longos em campos, cabeçalhos e rotas', '400 (ou 431 quando o servidor HTTP recusa o cabeçalho); banco inalterado', () => {
  const long = (n: number) => 'a'.repeat(n);
  const attempts: [string, () => Promise<Reply>][] = [
    ...FREE_TEXT.flatMap((field) => [256, 50_000].map((n): [string, () => Promise<Reply>] => [`${field} ${n}`, () => submit(payloadWith(field, long(n)))])),
    ['Idempotency-Key 256', () => submit(wagerPayload(wallet), long(256))],
    ['x-correlation-id 129', () => submit(wagerPayload(wallet), `k-${uuid()}`, { 'x-correlation-id': long(129) })],
    ['Idempotency-Key 32 KiB', () => submit(wagerPayload(wallet), long(32_768))],
    ['rota providerId 256', () => send(env.api, 'GET', `/providers/${long(256)}/wagering/transactions/x`)],
    ['rota externalTransactionId 5000', () => send(env.api, 'GET', `/providers/p/wagering/transactions/${long(5000)}`)],
    ['URL de 64 KiB', () => send(env.api, 'GET', `/wallets/${long(65_536)}`)],
    ['cursor de 10 000', () => send(env.api, 'GET', `/wallets/${wallet.walletId}/ledger?cursor=${long(10_000)}`)],
    ['limit com 400 dígitos', () => send(env.api, 'GET', `/wallets/${wallet.walletId}/ledger?limit=${'9'.repeat(400)}`)],
  ];
  return expectRejected(env.probe, attempts, [400, 431]);
});
