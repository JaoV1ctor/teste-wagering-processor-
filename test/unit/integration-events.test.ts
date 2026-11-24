// Envelope dos eventos de integração (README §11): eventType e version moram no TIPO; data só com MoneyProps (strings); JSON estável.
import { describe, expect, test } from 'bun:test';
import { IntegrationEvent } from '../../src/domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection, LedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const brl = (v: string) => Money.fromString(v, 'BRL');
const at = new Date('2026-03-01T12:00:00.000Z');
const WALLET = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';
const TX = '33333333-3333-4333-8333-333333333333';
const ctx = (overrides: Partial<{ eventId: string; correlationId: string; causationId: string }> = {}) => ({
  eventId: 'e0000000-0000-4000-8000-000000000001', correlationId: 'corr-1', occurredAt: at, ...overrides,
});

function transaction(kind: WagerTransactionKind = WagerTransactionKind.Bet, reference?: string): WagerTransaction {
  return WagerTransaction.create({
    id: TX, providerId: 'provider-a', externalTransactionId: 'ext-1', idempotencyKey: 'provider-a:ext-1', payloadHash: 'a'.repeat(64),
    walletId: WALLET, playerId: PLAYER, roundId: 'round-1', gameId: 'game-1', kind, money: brl('30.00'), now: at,
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  });
}

describe('IntegrationEvent', () => {
  test('é abstrata e cada evento tem eventType e version próprios no TIPO', () => {
    const processed = transaction();
    processed.markProcessed({ observedBalance: brl('70.00'), at });
    const rejected = transaction();
    rejected.reject(FailureCode.InsufficientBalance, brl('10.00'), at);
    const pending = transaction(WagerTransactionKind.Refund, 'ext-bet');
    pending.markPendingReference(new Date(at.getTime() + 1000), at);

    const events = [
      WagerTransactionProcessed.from(processed, ctx()),
      WagerTransactionRejected.from(rejected, ctx()),
      WagerTransactionPendingReference.from(pending, ctx()),
    ];
    expect(events.map((e) => [e.eventType, e.version])).toEqual([
      ['WagerTransactionProcessed', 1], ['WagerTransactionRejected', 1], ['WagerTransactionPendingReference', 1],
    ]);
    expect(events.every((e) => e instanceof IntegrationEvent)).toBe(true);
  });

  test('toJSON serializa o envelope: occurredAt ISO-8601, version, aggregateId, correlationId e sem causationId quando não existe', () => {
    const tx = transaction();
    tx.markProcessed({ observedBalance: brl('70.00'), at });
    const json = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(json).toEqual({
      eventId: 'e0000000-0000-4000-8000-000000000001', eventType: 'WagerTransactionProcessed', aggregateId: TX, correlationId: 'corr-1',
      occurredAt: '2026-03-01T12:00:00.000Z', version: 1,
      data: {
        transactionId: TX, providerId: 'provider-a', externalTransactionId: 'ext-1', walletId: WALLET, playerId: PLAYER, roundId: 'round-1',
        gameId: 'game-1', kind: WagerTransactionKind.Bet, money: { amount: '30.00', currency: 'BRL' }, balance: { amount: '70.00', currency: 'BRL' },
      },
    });
    expect('causationId' in json).toBe(false);
  });

  test('causationId aparece no envelope quando informado', () => {
    const tx = transaction();
    tx.markProcessed({ observedBalance: brl('70.00'), at });
    expect(WagerTransactionProcessed.from(tx, ctx({ causationId: 'causa-1' })).toJSON().causationId).toBe('causa-1');
  });

  test('data usa MoneyProps (strings) e sobrevive a um ciclo JSON sem perder nada: nenhuma instância de Money vaza', () => {
    const wallet = Wallet.rehydrate({ id: WALLET, playerId: PLAYER, currency: 'BRL', balance: brl('100.00'), version: 1, createdAt: at, updatedAt: at });
    const entry = wallet.debit(brl('30.00'), { entryId: 'l0000000-0000-4000-8000-000000000001', transactionId: TX, at });
    const event = WalletBalanceChanged.from(wallet, entry, ctx());
    const json = event.toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.data.money).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(typeof json.data.balanceBefore.amount).toBe('string');
  });

  test('WalletBalanceChanged: aggregateId é a wallet; leva direção, antes/depois e a version já incrementada', () => {
    const wallet = Wallet.rehydrate({ id: WALLET, playerId: PLAYER, currency: 'BRL', balance: brl('100.00'), version: 4, createdAt: at, updatedAt: at });
    const entry = wallet.credit(brl('25.50'), { entryId: 'l0000000-0000-4000-8000-000000000002', transactionId: TX, at });
    const json = WalletBalanceChanged.from(wallet, entry, ctx({ causationId: 'e0000000-0000-4000-8000-000000000009' })).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.aggregateId).toBe(WALLET);
    expect(json.causationId).toBe('e0000000-0000-4000-8000-000000000009');
    expect(json.data).toEqual({
      walletId: WALLET, transactionId: TX, direction: LedgerDirection.Credit, money: { amount: '25.50', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '125.50', currency: 'BRL' }, walletVersion: 5,
    });
  });

  test('Rejected carrega failureCode e o saldo visto; PendingReference carrega a referência que falta', () => {
    const rejected = transaction();
    rejected.reject(FailureCode.InsufficientBalance, brl('10.00'), at);
    expect(WagerTransactionRejected.from(rejected, ctx()).toJSON().data).toMatchObject({
      transactionId: TX, failureCode: 'INSUFFICIENT_BALANCE', balance: { amount: '10.00', currency: 'BRL' },
    });

    const pending = transaction(WagerTransactionKind.Rollback, 'ext-bet');
    pending.markPendingReference(new Date(at.getTime() + 1000), at);
    expect(WagerTransactionPendingReference.from(pending, ctx()).toJSON().data).toMatchObject({
      transactionId: TX, kind: 'ROLLBACK', referenceExternalTransactionId: 'ext-bet',
    });
  });

  test('exige o estado certo: Processed só de PROCESSED, Rejected só de REJECTED, PendingReference só de PENDING_REFERENCE', () => {
    expect(() => WagerTransactionProcessed.from(transaction(), ctx())).toThrow();
    expect(() => WagerTransactionRejected.from(transaction(), ctx())).toThrow();
    expect(() => WagerTransactionPendingReference.from(transaction(), ctx())).toThrow();
  });

  test('WalletBalanceChanged recusa lançamento de outra wallet', () => {
    const wallet = Wallet.rehydrate({ id: WALLET, playerId: PLAYER, currency: 'BRL', balance: brl('100.00'), version: 1, createdAt: at, updatedAt: at });
    const foreign = LedgerEntry.create({
      id: 'l0000000-0000-4000-8000-000000000003', walletId: '44444444-4444-4444-8444-444444444444', transactionId: TX,
      direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00'), createdAt: at,
    });
    expect(() => WalletBalanceChanged.from(wallet, foreign, ctx())).toThrow();
  });
});
