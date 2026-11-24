// Endpoints de wallet (SPEC §5.3) com a aplicação real sobre Postgres REAL.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, newPlayerId, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance, seedCredits } from '../support/db';

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

const createWallet = (playerId: string, amount = '1000.00', currency = 'BRL') =>
  api.call('POST', '/wallets', { playerId, initialBalance: { amount, currency } });

const rows = async (sql: string, params: unknown[]) => (await probe.query(sql, params)).rows;

describe('POST /wallets', () => {
  test('201: saldo inicial gera OPENING + CREDIT na mesma transação, version 1', async () => {
    const playerId = newPlayerId();
    const res = await createWallet(playerId);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const walletId: string = res.body.id;
    const [wallet] = await rows('select balance::text, version from wallets where id = $1', [walletId]);
    expect(wallet).toEqual({ balance: '1000.00', version: 1 });

    const transactions = await rows(
      `select provider_id, external_transaction_id, idempotency_key, kind, status, amount::text, observed_balance::text, payload_hash
         from wager_transactions where wallet_id = $1`, [walletId]);
    expect(transactions).toEqual([{
      provider_id: 'internal', external_transaction_id: `opening:${walletId}`, idempotency_key: `opening:${walletId}`,
      kind: 'OPENING', status: 'PROCESSED', amount: '1000.00', observed_balance: '1000.00', payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);

    const ledger = await rows('select direction, amount::text, balance_before::text, balance_after::text from wallet_ledger_entries where wallet_id = $1', [walletId]);
    expect(ledger).toEqual([{ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00' }]);
    expect(await ledgerBalance(probe, walletId)).toEqual({ stored: '1000.00', rebuilt: '1000.00', entries: 1 });
  });

  test('201: saldo inicial 0.00 não cria OPENING nem lançamento', async () => {
    const res = await createWallet(newPlayerId(), '0.00');
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(res.body.version).toBe(1);
    expect(await rows('select 1 from wager_transactions where wallet_id = $1', [res.body.id])).toHaveLength(0);
    expect(await rows('select 1 from wallet_ledger_entries where wallet_id = $1', [res.body.id])).toHaveLength(0);
  });

  test('normaliza para 2 casas na resposta', async () => {
    const res = await createWallet(newPlayerId(), '10.5');
    expect(res.status).toBe(201);
    expect(res.body.balance.amount).toBe('10.50');
  });

  test('valor acima de Number.MAX_SAFE_INTEGER centavos sem perda', async () => {
    const res = await createWallet(newPlayerId(), '12345678901234567.89');
    expect(res.status).toBe(201);
    expect(res.body.balance.amount).toBe('12345678901234567.89');
  });

  test('409 WALLET_ALREADY_EXISTS para o mesmo player e moeda; nada novo é gravado', async () => {
    const playerId = newPlayerId();
    const first = await createWallet(playerId, '10.00');
    const second = await createWallet(playerId, '99.00');

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(await rows('select 1 from wallets where player_id = $1', [playerId])).toHaveLength(1);
    expect(await rows('select 1 from wager_transactions where player_id = $1', [playerId])).toHaveLength(1);
    expect(await rows('select balance::text from wallets where player_id = $1', [playerId])).toEqual([{ balance: '10.00' }]);
  });

  test('mesmo player com outra moeda é outra wallet', async () => {
    const playerId = newPlayerId();
    expect((await createWallet(playerId, '1.00', 'BRL')).status).toBe(201);
    expect((await createWallet(playerId, '1.00', 'USD')).status).toBe(201);
  });

  const valid = { playerId: newPlayerId(), initialBalance: { amount: '1.00', currency: 'BRL' } };
  test.each([
    ['amount como number', { ...valid, initialBalance: { amount: 10.5, currency: 'BRL' } }],
    ['mais de 2 casas', { ...valid, initialBalance: { amount: '10.005', currency: 'BRL' } }],
    ['negativo', { ...valid, initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    ['amount vazio', { ...valid, initialBalance: { amount: '', currency: 'BRL' } }],
    ['amount não numérico', { ...valid, initialBalance: { amount: 'abc', currency: 'BRL' } }],
    ['notação científica', { ...valid, initialBalance: { amount: '1e3', currency: 'BRL' } }],
    ['acima de NUMERIC(19,2)', { ...valid, initialBalance: { amount: '100000000000000000.00', currency: 'BRL' } }],
    ['moeda minúscula', { ...valid, initialBalance: { amount: '1.00', currency: 'brl' } }],
    ['moeda com 4 letras', { ...valid, initialBalance: { amount: '1.00', currency: 'BRLL' } }],
    ['sem initialBalance', { playerId: valid.playerId }],
    ['sem playerId', { initialBalance: valid.initialBalance }],
    ['playerId não é uuid', { ...valid, playerId: 'abc' }],
    ['campo desconhecido', { ...valid, extra: 1 }],
    ['campo desconhecido em initialBalance', { ...valid, initialBalance: { ...valid.initialBalance, extra: 1 } }],
    ['body é array', []],
    ['body vazio', {}],
  ])('400 VALIDATION_ERROR: %s', async (_name, body) => {
    const res = await api.call('POST', '/wallets', JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  test('400 para JSON malformado, sem vazar detalhes internos', async () => {
    const res = await api.call('POST', '/wallets', '{"playerId": ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).not.toMatch(/at \S+ \(|node_modules/);
  });

  test('requisição inválida não cria nada', async () => {
    const playerId = newPlayerId();
    await api.call('POST', '/wallets', { playerId, initialBalance: { amount: '10.005', currency: 'BRL' } });
    expect(await rows('select 1 from wallets where player_id = $1', [playerId])).toHaveLength(0);
  });
});

describe('GET /wallets/:walletId', () => {
  test('200 com saldo e version', async () => {
    const created = await createWallet(newPlayerId(), '25.00');
    const res = await api.call('GET', `/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id, playerId: created.body.playerId, balance: { amount: '25.00', currency: 'BRL' }, version: 1 });
  });

  test('reflete saldo e version alterados no banco', async () => {
    const created = await createWallet(newPlayerId(), '25.00');
    await seedCredits(probe, created.body.id, 3);
    const res = await api.call('GET', `/wallets/${created.body.id}`);
    expect(res.body.balance.amount).toBe('28.00');
    expect(res.body.version).toBe(2);
  });

  test('404 WALLET_NOT_FOUND', async () => {
    const res = await api.call('GET', `/wallets/${uuid()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('400 para id que não é uuid (não chega ao banco)', async () => {
    const res = await api.call('GET', '/wallets/nao-e-uuid');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('rota inexistente: 404 no mesmo formato de erro', async () => {
    const res = await api.call('GET', '/nada');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  const ledgerOf = (id: string, query = '') => api.call('GET', `/wallets/${id}/ledger${query}`);

  test('lista o lançamento OPENING', async () => {
    const created = await createWallet(newPlayerId(), '1000.00');
    const res = await ledgerOf(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items).toEqual([{
      id: expect.any(String), transactionId: expect.any(String), direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' }, balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' }, createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    }]);
  });

  test('wallet sem lançamentos: lista vazia', async () => {
    const created = await createWallet(newPlayerId(), '0.00');
    const res = await ledgerOf(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test('pagina com cursor opaco e estável: sem repetição nem omissão, mesmo com inserções entre as páginas', async () => {
    const created = await createWallet(newPlayerId(), '1.00');
    const id: string = created.body.id;
    await seedCredits(probe, id, 119); // 120 lançamentos no total

    const first = await ledgerOf(id);
    expect(first.body.items).toHaveLength(50); // default
    expect(typeof first.body.nextCursor).toBe('string');
    expect(Buffer.from(first.body.nextCursor, 'base64url').toString()).toMatch(/^\d+$/); // opaco: base64 do seq

    await seedCredits(probe, id, 5); // chegam lançamentos novos depois da 1ª página

    const seen: string[] = first.body.items.map((i: { id: string }) => i.id);
    let cursor: string | null = first.body.nextCursor;
    while (cursor) {
      const page = await ledgerOf(id, `?cursor=${encodeURIComponent(cursor)}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
    }
    expect(seen).toHaveLength(125);
    expect(new Set(seen).size).toBe(125);

    const inDb = await rows('select id from wallet_ledger_entries where wallet_id = $1 order by seq', [id]);
    expect(seen).toEqual(inDb.map((r) => r.id));
  });

  test('limit respeita o pedido e tem teto de 100', async () => {
    const created = await createWallet(newPlayerId(), '1.00');
    await seedCredits(probe, created.body.id, 129);
    expect((await ledgerOf(created.body.id, '?limit=7')).body.items).toHaveLength(7);
    const capped = await ledgerOf(created.body.id, '?limit=1000');
    expect(capped.status).toBe(200);
    expect(capped.body.items).toHaveLength(100);
    expect(capped.body.nextCursor).not.toBeNull();
  });

  test('última página exata não devolve cursor', async () => {
    const created = await createWallet(newPlayerId(), '1.00');
    await seedCredits(probe, created.body.id, 3);
    const res = await ledgerOf(created.body.id, '?limit=4');
    expect(res.body.items).toHaveLength(4);
    expect(res.body.nextCursor).toBeNull();
  });

  test.each([
    ['cursor que não é base64 de seq', `?cursor=${Buffer.from('abc').toString('base64url')}`, 'INVALID_CURSOR'],
    ['cursor lixo', '?cursor=!!!', 'INVALID_CURSOR'],
    ['limit zero', '?limit=0', 'VALIDATION_ERROR'],
    ['limit negativo', '?limit=-1', 'VALIDATION_ERROR'],
    ['limit não numérico', '?limit=abc', 'VALIDATION_ERROR'],
    ['limit decimal', '?limit=1.5', 'VALIDATION_ERROR'],
    ['parâmetro desconhecido', '?foo=1', 'VALIDATION_ERROR'],
  ])('400: %s', async (_name, query, code) => {
    const created = await createWallet(newPlayerId(), '1.00');
    const res = await ledgerOf(created.body.id, query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  test('404 para wallet inexistente e 400 para id inválido', async () => {
    expect((await ledgerOf(uuid())).status).toBe(404);
    expect((await ledgerOf('xyz')).status).toBe(400);
  });
});
