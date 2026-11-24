// A abertura da wallet (OPENING) altera o saldo, então gera os mesmos eventos de qualquer outra transação aplicada (SPEC §3.9).
// Postgres REAL, aplicação real. Os eventos nascem na MESMA transação da criação (wallet -> transação -> ledger -> outbox).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Api, newPlayerId, startApi } from '../support/app';
import { createProbe, ensureSchema } from '../support/db';
import { expectEventsConsistentWithLedger, outboxOfTransaction, outboxOfWallet, typesOf } from '../support/events';

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

const createWallet = (playerId: string, amount: string) =>
  api.call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });

const openingTransactionId = async (walletId: string): Promise<string> => {
  const { rows } = await probe.query<{ id: string }>("select id from wager_transactions where wallet_id = $1 and kind = 'OPENING'", [walletId]);
  const id = rows[0]?.id;
  if (!id) throw new Error('transação OPENING ausente');
  return id;
};

const eventsOfPlayer = async (playerId: string): Promise<number> => {
  const { rows } = await probe.query<{ n: string }>("select count(*)::text as n from outbox_messages where payload->'data'->>'playerId' = $1", [playerId]);
  return Number.parseInt(rows[0]?.n ?? '-1', 10);
};

describe('POST /wallets com saldo inicial > 0', () => {
  test('o saldo inicial aparece nos eventos: Processed (OPENING) e BalanceChanged (0.00 -> saldo, walletVersion 1)', async () => {
    const playerId = newPlayerId();
    const res = await createWallet(playerId, '250.00');
    expect(res.status).toBe(201);
    const walletId: string = res.body.id;
    const transactionId = await openingTransactionId(walletId);

    const rows = await outboxOfTransaction(probe, transactionId);
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [processed, changed] = rows;
    if (!processed || !changed) throw new Error('eventos ausentes');

    expect(processed.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed', version: 1, aggregateId: transactionId, correlationId: transactionId,
      data: {
        transactionId, providerId: 'internal', externalTransactionId: `opening:${walletId}`, walletId, playerId, kind: 'OPENING',
        money: { amount: '250.00', currency: 'BRL' }, balance: { amount: '250.00', currency: 'BRL' },
      },
    });
    expect(changed.aggregate_id).toBe(walletId);
    expect(changed.payload).toMatchObject({
      eventType: 'WalletBalanceChanged', version: 1, aggregateId: walletId, correlationId: transactionId, causationId: processed.id,
      data: {
        walletId, transactionId, direction: 'CREDIT', money: { amount: '250.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' }, balanceAfter: { amount: '250.00', currency: 'BRL' }, walletVersion: 1,
      },
    });
    expect(processed.published_at).toBeNull();
    await expectEventsConsistentWithLedger(probe, walletId);
  });

  test('os eventos da abertura e os das apostas seguintes fecham com o ledger e a version da wallet', async () => {
    const playerId = newPlayerId();
    const walletId: string = (await createWallet(playerId, '100.00')).body.id;
    const bet = await api.call('POST', '/wagering/transactions', {
      providerId: 'provider-a', externalTransactionId: `ext-${walletId}`, playerId, walletId, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '30.00', currency: 'BRL' },
    }, { 'idempotency-key': `provider-a:ext-${walletId}` });
    expect(bet.status).toBe(201);

    const types = typesOf(await outboxOfWallet(probe, walletId, { includeOpening: true }));
    expect(types.filter((type) => type === 'WalletBalanceChanged')).toHaveLength(2);
    await expectEventsConsistentWithLedger(probe, walletId);
  });
});

describe('o que NÃO gera evento na criação', () => {
  test('saldo inicial 0.00: sem OPENING, sem ledger e sem evento', async () => {
    const playerId = newPlayerId();
    const res = await createWallet(playerId, '0.00');
    expect(res.status).toBe(201);
    expect(await outboxOfWallet(probe, res.body.id, { includeOpening: true })).toEqual([]);
    expect(await eventsOfPlayer(playerId)).toBe(0);
  });

  test('wallet duplicada (409): nenhum evento novo; os da primeira criação permanecem', async () => {
    const playerId = newPlayerId();
    const first = await createWallet(playerId, '80.00');
    expect(first.status).toBe(201);
    const before = typesOf(await outboxOfWallet(probe, first.body.id, { includeOpening: true }));
    expect(before).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await eventsOfPlayer(playerId)).toBe(1); // só o Processed carrega o playerId

    const duplicate = await createWallet(playerId, '999.00');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');

    expect(typesOf(await outboxOfWallet(probe, first.body.id, { includeOpening: true }))).toEqual(before);
    expect(await eventsOfPlayer(playerId)).toBe(1);
    await expectEventsConsistentWithLedger(probe, first.body.id);
  });
});
