// Endpoints /wagering (SPEC §5.2 e §5.3) com a aplicação real sobre Postgres REAL.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

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

const rows = async (sql: string, params: unknown[]) => (await probe.query(sql, params)).rows;
const post = (payload: ReturnType<typeof wagerPayload>) => submit(api, payload, defaultKey(payload));

describe('POST /wagering/transactions — resultados de negócio', () => {
  test('BET processada: 201 e corpo exato; wallet e ledger conferem', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const res = await post(payload);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: { amount: '70.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    const [wallet2] = await rows('select version from wallets where id = $1', [wallet.walletId]);
    expect(wallet2).toEqual({ version: 2 });
  });

  test('WIN credita; LOSS não move saldo nem gera lançamento', async () => {
    const wallet = await openWallet(api, '100.00');
    const win = await post(wagerPayload(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } }));
    expect(win.status).toBe(201);
    expect(win.body.balance).toEqual({ amount: '150.00', currency: 'BRL' });

    const loss = await post(wagerPayload(wallet, { kind: 'LOSS', money: { amount: '40.00', currency: 'BRL' } }));
    expect(loss.status).toBe(201);
    expect(loss.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: { amount: '150.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '150.00', rebuilt: '150.00', entries: 2 });
  });

  test('saldo insuficiente: 422 com failureCode, auditável (transação REJECTED), sem lançamento', async () => {
    const wallet = await openWallet(api, '10.00');
    const payload = wagerPayload(wallet, { money: { amount: '10.01', currency: 'BRL' } });
    const res = await post(payload);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String), status: 'REJECTED', balance: { amount: '10.00', currency: 'BRL' }, idempotentReplay: false, failureCode: 'INSUFFICIENT_BALANCE',
    });
    expect(await rows('select status, failure_code, observed_balance::text from wager_transactions where id = $1', [res.body.transactionId])).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE', observed_balance: '10.00' },
    ]);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 1 });
  });

  test('moeda diferente da wallet: 422 CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet(api, '100.00');
    const res = await post(wagerPayload(wallet, { money: { amount: '5.00', currency: 'USD' } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(res.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  });

  test('player diferente do dono da wallet: 422 PLAYER_MISMATCH', async () => {
    const wallet = await openWallet(api, '100.00');
    const res = await post(wagerPayload(wallet, { playerId: uuid() }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('PLAYER_MISMATCH');
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  });

  test('WIN que estoura NUMERIC(19,2): 422 BALANCE_LIMIT_EXCEEDED auditável (não 500), sem lançamento; replay devolve o mesmo 422', async () => {
    const wallet = await openWallet(api, '99999999999999999.00');
    const payload = wagerPayload(wallet, { kind: 'WIN', money: { amount: '1.01', currency: 'BRL' } });
    const first = await post(payload);

    expect(first.status).toBe(422);
    expect(first.body).toEqual({
      transactionId: expect.any(String), status: 'REJECTED', balance: { amount: '99999999999999999.00', currency: 'BRL' },
      idempotentReplay: false, failureCode: 'BALANCE_LIMIT_EXCEEDED',
    });
    expect(await rows('select status, failure_code from wager_transactions where id = $1', [first.body.transactionId])).toEqual([
      { status: 'REJECTED', failure_code: 'BALANCE_LIMIT_EXCEEDED' },
    ]);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '99999999999999999.00', rebuilt: '99999999999999999.00', entries: 1 });
    const replay = await post(payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('wallet inexistente: 404 WALLET_NOT_FOUND e nada persistido', async () => {
    const payload = wagerPayload({ walletId: uuid(), playerId: uuid() });
    const res = await post(payload);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
    expect(await rows('select 1 from wager_transactions where provider_id = $1 and external_transaction_id = $2', [payload.providerId, payload.externalTransactionId])).toHaveLength(0);
  });
});

describe('POST /wagering/transactions — idempotência', () => {
  test('replay devolve o MESMO status e corpo, só com idempotentReplay: true; não há segundo débito', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const first = await post(payload);
    const second = await post(payload);

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('replay devolve o saldo da época, mesmo depois de a wallet mudar', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const first = await post(payload);
    await post(wagerPayload(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }));

    const replay = await post(payload);
    expect(replay.body.balance).toEqual(first.body.balance);
    expect(replay.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  });

  test('replay de rejeição devolve 422 e o mesmo failureCode, sem reprocessar (mesmo que agora houvesse saldo)', async () => {
    const wallet = await openWallet(api, '10.00');
    const payload = wagerPayload(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    const first = await post(payload);
    await post(wagerPayload(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }));

    const replay = await post(payload);
    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('mesma chave com payload diferente: 409 IDEMPOTENCY_CONFLICT, nada muda', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    await post(payload);
    const res = await submit(api, { ...payload, money: { amount: '31.00', currency: 'BRL' } }, defaultKey(payload));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('mesmo externalTransactionId com OUTRA Idempotency-Key: 409 (UNIQUE do banco), nada muda', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    await post(payload);
    const res = await submit(api, payload, `outra-chave-${uuid()}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('a Idempotency-Key é a fonte da verdade: chave própria funciona e é reaplicada como replay', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    const key = `chave-do-provedor-${uuid()}`;
    const first = await submit(api, payload, key);
    const second = await submit(api, payload, key);
    expect(first.status).toBe(201);
    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('Idempotency-Key ausente: 400', async () => {
    const wallet = await openWallet(api, '100.00');
    const res = await submit(api, wagerPayload(wallet), undefined);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /wagering/transactions — validação (400)', () => {
  const invalid = async (change: Record<string, unknown>) => {
    const wallet = await openWallet(api, '100.00');
    const payload = { ...wagerPayload(wallet), ...change };
    return submit(api, payload, 'k');
  };

  test.each([
    ['OPENING', { kind: 'OPENING' }],
    ['REFUND (Fase 3)', { kind: 'REFUND' }],
    ['valor zero', { money: { amount: '0.00', currency: 'BRL' } }],
    ['3 casas decimais', { money: { amount: '10.005', currency: 'BRL' } }],
    ['valor number', { money: { amount: 10, currency: 'BRL' } }],
    ['playerId malformado', { playerId: 'x' }],
  ])('%s', async (_name, change) => {
    const res = await invalid(change);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test.each(['nao-e-uuid', '123', '00000000-0000-0000-0000-00000000000', `${uuid()}; drop table wallets`])(
    'walletId %p: 400 na borda, antes de qualquer SQL (o Postgres nunca vê o valor: sem 22P02 vazando como 500) e nada persistido',
    async (walletId) => {
      const payload = wagerPayload({ walletId, playerId: uuid() });
      const res = await post(payload);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual([{ path: 'walletId', message: expect.any(String) }]);
      expect(await rows('select 1 from wager_transactions where provider_id = $1 and external_transaction_id = $2', [payload.providerId, payload.externalTransactionId])).toHaveLength(0);
    },
  );

  test('referenceExternalTransactionId em WIN: 400 explicando que ainda não é suportado, e nada é persistido', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = { ...wagerPayload(wallet, { kind: 'WIN' }), referenceExternalTransactionId: 'bet-1' };
    const res = await submit(api, payload, 'k');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toMatch(/referenceExternalTransactionId/);
    expect(await rows('select 1 from wager_transactions where wallet_id = $1 and kind = $2', [wallet.walletId, 'WIN'])).toHaveLength(0);
  });
});

describe('GET /wagering/transactions/:transactionId', () => {
  test('200 com a representação completa', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const created = await post(payload);
    const res = await api.call('GET', `/wagering/transactions/${created.body.transactionId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: created.body.transactionId, providerId: payload.providerId, externalTransactionId: payload.externalTransactionId,
      walletId: wallet.walletId, playerId: wallet.playerId, roundId: payload.roundId, gameId: payload.gameId, kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' }, status: 'PROCESSED', failureCode: null, balance: { amount: '70.00', currency: 'BRL' },
      createdAt: expect.any(String), processedAt: expect.any(String),
    });
  });

  test('transação rejeitada aparece com status REJECTED e failureCode', async () => {
    const wallet = await openWallet(api, '1.00');
    const created = await post(wagerPayload(wallet));
    const res = await api.call('GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE', processedAt: null });
  });

  test('id inexistente: 404 TRANSACTION_NOT_FOUND; id malformado: 400', async () => {
    const missing = await api.call('GET', `/wagering/transactions/${uuid()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await api.call('GET', '/wagering/transactions/nao-e-uuid')).status).toBe(400);
  });
});

describe('GET /providers/:providerId/wagering/transactions/:externalTransactionId', () => {
  test('200 pela chave do provedor; mesma transação do GET por id', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    const created = await post(payload);
    const res = await api.call('GET', `/providers/${payload.providerId}/wagering/transactions/${payload.externalTransactionId}`);

    expect(res.status).toBe(200);
    expect(res.body.transactionId).toBe(created.body.transactionId);
    expect(res.body).toEqual((await api.call('GET', `/wagering/transactions/${created.body.transactionId}`)).body);
  });

  test('provedor ou id externo desconhecido: 404 TRANSACTION_NOT_FOUND', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    await post(payload);
    const otherProvider = await api.call('GET', `/providers/outro/wagering/transactions/${payload.externalTransactionId}`);
    expect(otherProvider.status).toBe(404);
    expect(otherProvider.body.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await api.call('GET', `/providers/${payload.providerId}/wagering/transactions/inexistente`)).status).toBe(404);
  });
});
