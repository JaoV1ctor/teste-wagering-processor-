// Regras de BET/WIN/LOSS sobre a wallet (SPEC §3.5, §3.8 e §4). Domínio puro: sem banco.
import { describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { settleWager } from '../../src/domain/wager-settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const at = new Date('2026-01-01T12:00:00.000Z');
const money = (amount: string, currency = 'BRL') => Money.fromString(amount, currency);

function walletWith(balance: string): Wallet {
  return Wallet.create({
    id: uuid(), playerId: uuid(), initialBalance: money(balance), openingTransactionId: uuid(), openingEntryId: uuid(), now: at,
  }).wallet;
}

function transaction(wallet: Wallet, kind: WagerTransactionKind, amount: Money, playerId = wallet.playerId): WagerTransaction {
  return WagerTransaction.create({
    id: uuid(), providerId: 'provider-a', externalTransactionId: `ext-${uuid()}`, idempotencyKey: `key-${uuid()}`, payloadHash: 'a'.repeat(64),
    walletId: wallet.id, playerId, roundId: 'round-1', gameId: 'game-1', kind, money: amount, now: at,
  });
}

const settle = (wallet: Wallet, tx: WagerTransaction) => settleWager(wallet, tx, { entryId: uuid(), at });

describe('BET', () => {
  test('debita, gera lançamento DEBIT encadeado e fica PROCESSED com o saldo observado', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, WagerTransactionKind.Bet, money('30.00'));
    const entry = settle(wallet, tx);

    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry).toMatchObject({ direction: LedgerDirection.Debit, transactionId: tx.id, walletId: wallet.id });
    expect(entry?.balanceBefore.toString()).toBe('100.00');
    expect(entry?.balanceAfter.toString()).toBe('70.00');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.observedBalance?.toString()).toBe('70.00');
    expect(tx.processedAt).toEqual(at);
  });

  test('aposta igual ao saldo zera a wallet (saldo nunca fica negativo)', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, WagerTransactionKind.Bet, money('100.00'));
    settle(wallet, tx);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test('saldo insuficiente: REJECTED/INSUFFICIENT_BALANCE, sem lançamento, wallet intacta, saldo observado gravado', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, WagerTransactionKind.Bet, money('100.01'));
    const entry = settle(wallet, tx);

    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(tx.observedBalance?.toString()).toBe('100.00');
    expect(tx.processedAt).toBeUndefined();
  });
});

describe('WIN', () => {
  test('credita, gera lançamento CREDIT e fica PROCESSED', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, WagerTransactionKind.Win, money('50.25'));
    const entry = settle(wallet, tx);

    expect(wallet.balance.toString()).toBe('150.25');
    expect(wallet.version).toBe(2);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toString()).toBe('100.00');
    expect(entry?.balanceAfter.toString()).toBe('150.25');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.observedBalance?.toString()).toBe('150.25');
  });
});

describe('WIN que estoura o limite de NUMERIC(19,2)', () => {
  test('REJECTED/BALANCE_LIMIT_EXCEEDED: sem lançamento, wallet intacta, saldo observado gravado (nunca vira erro 500)', () => {
    const wallet = walletWith('99999999999999999.00');
    const tx = transaction(wallet, WagerTransactionKind.Win, money('1.01'));
    const entry = settle(wallet, tx);

    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('99999999999999999.00');
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.BalanceLimitExceeded);
    expect(tx.observedBalance?.toString()).toBe('99999999999999999.00');
  });

  test('chegar exatamente ao limite é permitido', () => {
    const wallet = walletWith('99999999999999999.00');
    const tx = transaction(wallet, WagerTransactionKind.Win, money('0.99'));
    settle(wallet, tx);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('99999999999999999.99');
  });
});

describe('LOSS', () => {
  test('não move saldo, não gera lançamento, não sobe version; fica PROCESSED com o saldo atual', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, WagerTransactionKind.Loss, money('40.00'));
    const entry = settle(wallet, tx);

    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.observedBalance?.toString()).toBe('100.00');
  });

  test('LOSS maior que o saldo não é rejeitada (não debita)', () => {
    const wallet = walletWith('10.00');
    const tx = transaction(wallet, WagerTransactionKind.Loss, money('999.00'));
    settle(wallet, tx);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe.each([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss])('divergências com a wallet (%s)', (kind) => {
  test('moeda diferente: REJECTED/CURRENCY_MISMATCH, wallet e ledger intactos', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, kind, money('10.00', 'USD'));
    const entry = settle(wallet, tx);

    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(tx.observedBalance?.toString()).toBe('100.00');
  });

  test('player diferente do dono: REJECTED/PLAYER_MISMATCH, wallet e ledger intactos', () => {
    const wallet = walletWith('100.00');
    const tx = transaction(wallet, kind, money('10.00'), uuid());
    const entry = settle(wallet, tx);

    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.PlayerMismatch);
  });
});

test('player e moeda divergentes ao mesmo tempo: PLAYER_MISMATCH tem precedência (identidade antes de moeda)', () => {
  const wallet = walletWith('100.00');
  const tx = transaction(wallet, WagerTransactionKind.Bet, money('10.00', 'USD'), uuid());
  settle(wallet, tx);
  expect(tx.failureCode).toBe(FailureCode.PlayerMismatch);
});

test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback, WagerTransactionKind.Opening])(
  '%s não é liquidada aqui (reversões são da Fase 3; OPENING é interna): erro de programação',
  (kind) => {
    const wallet = walletWith('100.00');
    const base = { id: uuid(), providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'a'.repeat(64), walletId: wallet.id,
      playerId: wallet.playerId, roundId: 'r', gameId: 'g', kind, money: money('10.00'), now: at };
    const tx = WagerTransaction.create(kind === WagerTransactionKind.Opening ? base : { ...base, referenceExternalTransactionId: 'ref' });
    expect(() => settle(wallet, tx)).toThrow(InvalidWagerTransactionError);
    expect(wallet.balance.toString()).toBe('100.00');
  },
);
