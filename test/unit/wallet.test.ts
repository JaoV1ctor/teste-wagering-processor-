import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (v: string) => Money.fromString(v, 'BRL');
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:05Z');

const open = (initial: string) =>
  Wallet.create({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), openingTransactionId: 'tx0', openingEntryId: 'e0', now: t0 });

const posting = (n: number) => ({ entryId: `e${n}`, transactionId: `tx${n}`, at: t1 });

describe('Wallet.create', () => {
  test('saldo inicial > 0: version 1, saldo e lançamento CREDIT de 0 até o saldo', () => {
    const { wallet, openingEntry } = open('1000.00');
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe('tx0');
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  test('saldo inicial 0: sem lançamento', () => {
    const { wallet, openingEntry } = open('0');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });
});

describe('Wallet.debit / credit', () => {
  test('débito reduz o saldo, sobe version e devolve o lançamento correspondente', () => {
    const { wallet } = open('100');
    const entry = wallet.debit(brl('80'), posting(1));
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.walletId).toBe('w1');
    expect(entry.transactionId).toBe('tx1');
  });

  test('crédito aumenta o saldo e sobe version', () => {
    const { wallet } = open('10');
    const entry = wallet.credit(brl('5.50'), posting(1));
    expect(wallet.balance.toString()).toBe('15.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('saldo nunca fica negativo: débito acima do saldo lança e não altera o estado', () => {
    const { wallet } = open('100');
    expect(() => wallet.debit(brl('100.01'), posting(1))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('débito do saldo exato zera a wallet', () => {
    const { wallet } = open('100');
    wallet.debit(brl('100'), posting(1));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('duas apostas de 80 em saldo 100: a segunda falha', () => {
    const { wallet } = open('100');
    wallet.debit(brl('80'), posting(1));
    expect(() => wallet.debit(brl('80'), posting(2))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('moeda diferente é rejeitada', () => {
    const { wallet } = open('100');
    const usd = Money.fromString('1', 'USD');
    expect(() => wallet.debit(usd, posting(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, posting(1))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('valor zero é rejeitado e não muda version', () => {
    const { wallet } = open('100');
    expect(() => wallet.debit(brl('0'), posting(1))).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(brl('0'), posting(1))).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  test('crédito que estouraria o máximo de NUMERIC(19,2) é rejeitado sem alterar o estado', () => {
    const { wallet } = open('99999999999999999.99');
    expect(() => wallet.credit(brl('0.01'), posting(1))).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  test('cadeia: o balanceBefore de cada lançamento é o balanceAfter do anterior', () => {
    const { wallet, openingEntry } = open('100');
    const e1 = wallet.debit(brl('30'), posting(1));
    const e2 = wallet.credit(brl('5'), posting(2));
    expect(openingEntry && e1.balanceBefore.equals(openingEntry.balanceAfter)).toBe(true);
    expect(e2.balanceBefore.equals(e1.balanceAfter)).toBe(true);
    expect(wallet.balance.equals(e2.balanceAfter)).toBe(true);
  });
});

describe('Wallet.rehydrate / toState', () => {
  test('reidrata sem revalidar e devolve o mesmo estado', () => {
    const state = { id: 'w9', playerId: 'p9', currency: 'BRL', balance: brl('42'), version: 7, createdAt: t0, updatedAt: t1 };
    const wallet = Wallet.rehydrate(state);
    expect(wallet).toBeInstanceOf(Wallet);
    expect(wallet.toState()).toEqual(state);
  });
});
