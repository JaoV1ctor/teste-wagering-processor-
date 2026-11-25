// UUID em maiúsculas é o mesmo UUID: mesmo resultado, mesmo payloadHash, mesmas respostas. Postgres REAL, aplicação real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { buildWagerMessage } from '../../scripts/send-wager-message';
import { computePayloadHash } from '../../src/application/payload-hash';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { WagerMessageHandler } from '../../src/interface/sqs/wager-message-handler';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { outboxOfTransaction, outboxOfWallet } from '../support/events';
import { defaultKey, openWallet, submit, type WagerPayload, wagerPayload } from '../support/wager';

const probe = createProbe();
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
});

const upper = (value: string): string => value.toUpperCase();
const withUpperIds = (payload: WagerPayload): WagerPayload => ({ ...payload, walletId: upper(payload.walletId), playerId: upper(payload.playerId) });
const wagerRows = async (walletId: string) =>
  (await probe.query<{ id: string; payload_hash: string; player_id: string }>(
    "select id, payload_hash, player_id from wager_transactions where wallet_id = $1 and kind <> 'OPENING'", [walletId],
  )).rows;
const hashOf = (payload: WagerPayload): string => computePayloadHash(payload);

describe('POST /wagering/transactions com UUIDs em maiúsculas', () => {
  test.each([
    ['walletId e playerId', withUpperIds],
    ['só o playerId', (payload: WagerPayload) => ({ ...payload, playerId: upper(payload.playerId) })],
    ['só o walletId', (payload: WagerPayload) => ({ ...payload, walletId: upper(payload.walletId) })],
  ])('%s: mesmo resultado que em minúsculas, com payloadHash e eventos em minúsculas', async (_name, change) => {
    const lowerWallet = await openWallet(api, '100.00');
    const upperWallet = await openWallet(api, '100.00');
    const lowerPayload = wagerPayload(lowerWallet);
    const canonical = wagerPayload(upperWallet);
    const sent = change(canonical);

    const lower = await submit(api, lowerPayload, defaultKey(lowerPayload));
    const res = await submit(api, sent, defaultKey(sent));

    expect(res.status).toBe(lower.status);
    expect(res.body).toEqual({ ...lower.body, transactionId: expect.any(String) });
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
    expect(await ledgerBalance(probe, upperWallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    expect(await wagerRows(upperWallet.walletId)).toEqual([{ id: res.body.transactionId, payload_hash: hashOf(canonical), player_id: upperWallet.playerId }]);
    const events = await outboxOfTransaction(probe, res.body.transactionId);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.payload.data['walletId']).toBe(upperWallet.walletId);
  });

  test.each([
    ['maiúsculas e depois minúsculas', true],
    ['minúsculas e depois maiúsculas', false],
  ])('mesma Idempotency-Key, %s: replay (não 409), um único débito', async (_name, upperFirst) => {
    const wallet = await openWallet(api, '100.00');
    const lower = wagerPayload(wallet);
    const [first, second] = upperFirst ? [withUpperIds(lower), lower] : [lower, withUpperIds(lower)];

    const original = await submit(api, first, defaultKey(lower));
    const replay = await submit(api, second, defaultKey(lower));

    expect(original.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    expect((await wagerRows(wallet.walletId)).map((row) => row.payload_hash)).toEqual([hashOf(lower)]);
  });
});

describe('POST /wallets com playerId em maiúsculas', () => {
  test('responde e publica em minúsculas; repetir em minúsculas é a mesma wallet (409)', async () => {
    const playerId = uuid();
    const initialBalance = { amount: '10.00', currency: 'BRL' };

    const created = await api.call('POST', '/wallets', { playerId: upper(playerId), initialBalance });
    const again = await api.call('POST', '/wallets', { playerId, initialBalance });

    expect(created.status).toBe(201);
    expect(created.body.playerId).toBe(playerId);
    const events = await outboxOfWallet(probe, created.body.id, { includeOpening: true });
    expect(events.map((event) => event.payload.data['playerId']).filter((value) => value !== undefined)).not.toContain(upper(playerId));
    const { rows } = await probe.query<{ payload_hash: string }>("select payload_hash from wager_transactions where wallet_id = $1 and kind = 'OPENING'", [created.body.id]);
    expect(rows[0]?.payload_hash).toBe(computePayloadHash({
      providerId: 'internal', externalTransactionId: `opening:${created.body.id}`, playerId, walletId: created.body.id,
      roundId: 'opening', gameId: 'opening', kind: 'OPENING', money: initialBalance,
    }));
    expect(again.status).toBe(409);
  });
});

describe('rotas que recebem UUID aceitam maiúsculas', () => {
  test.each([
    ['GET /wallets/:walletId', 'GET', (w: string) => `/wallets/${w}`],
    ['GET /wallets/:walletId/ledger', 'GET', (w: string) => `/wallets/${w}/ledger?limit=10`],
    ['GET /wagering/transactions/:transactionId', 'GET', (_w: string, t: string) => `/wagering/transactions/${t}`],
    ['POST /wallets/:walletId/reconciliation', 'POST', (w: string) => `/wallets/${w}/reconciliation`],
  ])('%s devolve a mesma resposta', async (_name, method, path) => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    const { body } = await submit(api, payload, defaultKey(payload));

    const lower = await api.call(method, path(wallet.walletId, body.transactionId));
    const res = await api.call(method, path(upper(wallet.walletId), upper(body.transactionId)));

    expect(lower.status).toBe(200);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(lower.body);
  });
});

describe('entrada SQS (handler real sobre o caso de uso e o banco reais)', () => {
  const handler = () =>
    new WagerMessageHandler(api.app.get(ProcessWagerTransactionUseCase), {
      consumerName: `uuid-case-${uuid()}`, backoff: { baseSeconds: 1, maxSeconds: 1 }, log: () => undefined,
    });
  const message = (payload: WagerPayload) => {
    const { money, ...rest } = payload;
    return buildWagerMessage({ ...rest, amount: money.amount, currency: money.currency, idempotencyKey: defaultKey(payload) });
  };

  test('mensagem com UUIDs em maiúsculas é processada, sem PLAYER_MISMATCH', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);

    expect(await handler().handle(JSON.stringify(message(withUpperIds(payload))), 1)).toEqual({ action: 'ack' });

    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    expect((await wagerRows(wallet.walletId)).map((row) => row.payload_hash)).toEqual([hashOf(payload)]);
  });

  test('HTTP em minúsculas e a mesma chave pela fila em maiúsculas: replay com ack, não vai à DLQ', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    await submit(api, payload, defaultKey(payload));

    expect(await handler().handle(JSON.stringify(message(withUpperIds(payload))), 1)).toEqual({ action: 'ack' });

    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    expect(await wagerRows(wallet.walletId)).toHaveLength(1);
  });
});
