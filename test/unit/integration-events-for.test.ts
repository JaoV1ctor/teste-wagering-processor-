// Quais eventos nascem de uma liquidação. Função pura: o estado final da transação e o lançamento decidem.
import { describe, expect, test } from 'bun:test';
import { integrationEventsFor } from '../../src/application/integration-events';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { settleWager } from '../../src/domain/wager-settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const brl = (v: string) => Money.fromString(v, 'BRL');
const at = new Date('2026-03-01T12:00:00.000Z');
const WALLET = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

const wallet = (balance = '100.00') => Wallet.rehydrate({ id: WALLET, playerId: PLAYER, currency: 'BRL', balance: brl(balance), version: 1, createdAt: at, updatedAt: at });

function tx(kind: WagerTransactionKind, amount: string, reference?: string): WagerTransaction {
  return WagerTransaction.create({
    id: crypto.randomUUID(), providerId: 'p', externalTransactionId: `x-${crypto.randomUUID()}`, idempotencyKey: `k-${crypto.randomUUID()}`,
    payloadHash: 'a'.repeat(64), walletId: WALLET, playerId: PLAYER, roundId: 'r', gameId: 'g', kind, money: brl(amount), now: at,
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  });
}

let counter = 0;
const newId = () => `e0000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;

function eventsAfterSettle(transaction: WagerTransaction, w: Wallet, previousStatus = WagerTransactionStatus.Pending, correlated = true) {
  const correlationId = correlated ? 'corr-1' : undefined;
  const entry = settleWager(w, transaction, { entryId: newId(), at, random: () => 0 });
  return integrationEventsFor({ transaction, wallet: w, entry, previousStatus, correlationId, at, newId });
}

describe('integrationEventsFor', () => {
  test('BET processada: Processed e depois BalanceChanged (causado pelo Processed)', () => {
    const events = eventsAfterSettle(tx(WagerTransactionKind.Bet, '30.00'), wallet());
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events[0]?.toJSON().causationId).toBeUndefined();
    expect(events[1]?.toJSON().causationId).toBe(events[0]?.eventId);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
    expect(events.every((e) => e.toJSON().correlationId === 'corr-1')).toBe(true);
  });

  test('LOSS: só Processed (o saldo não muda, então nunca BalanceChanged)', () => {
    const events = eventsAfterSettle(tx(WagerTransactionKind.Loss, '30.00'), wallet());
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed']);
  });

  test('REJECTED: só Rejected, nenhum BalanceChanged', () => {
    const events = eventsAfterSettle(tx(WagerTransactionKind.Bet, '500.00'), wallet());
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
  });

  test('referência ausente na 1ª avaliação: PendingReference', () => {
    const events = eventsAfterSettle(tx(WagerTransactionKind.Refund, '30.00', 'ext-bet'), wallet());
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionPendingReference']);
  });

  test('reagendamento de quem JÁ estava PENDING_REFERENCE não gera evento novo', () => {
    const pending = tx(WagerTransactionKind.Refund, '30.00', 'ext-bet');
    pending.markPendingReference(new Date(at.getTime() + 1000), at);
    const events = eventsAfterSettle(pending, wallet(), WagerTransactionStatus.PendingReference);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(events).toEqual([]);
  });

  test('limite do worker esgotado: Rejected (REFERENCE_NOT_FOUND) e nenhum BalanceChanged', () => {
    const pending = tx(WagerTransactionKind.Refund, '30.00', 'ext-bet');
    for (let i = 0; i < 8; i += 1) pending.markPendingReference(at, at);
    const events = eventsAfterSettle(pending, wallet(), WagerTransactionStatus.PendingReference);
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
    expect(pending.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('sem correlationId do chamador, usa o id da transação', () => {
    const transaction = tx(WagerTransactionKind.Loss, '1.00');
    const events = eventsAfterSettle(transaction, wallet(), WagerTransactionStatus.Pending, false);
    expect(events[0]?.toJSON().correlationId).toBe(transaction.id);
  });

  test('estado que a liquidação nunca produz é erro de programação', () => {
    expect(() => integrationEventsFor({
      transaction: tx(WagerTransactionKind.Bet, '1.00'), wallet: wallet(), entry: undefined, previousStatus: WagerTransactionStatus.Pending,
      correlationId: 'c', at, newId,
    })).toThrow();
  });
});
