import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, LedgerEntryNotBalancedError } from '../../src/domain/errors';
import { LedgerDirection, LedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';

const brl = (v: string) => Money.fromString(v, 'BRL');
const base = { id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: new Date('2026-01-01T00:00:00Z') };

describe('LedgerEntry.create', () => {
  test('crédito balanceado', () => {
    const entry = LedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('30'), balanceBefore: brl('70'), balanceAfter: brl('100') });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.money.toString()).toBe('30.00');
  });

  test('débito balanceado', () => {
    const entry = LedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('80'), balanceBefore: brl('100'), balanceAfter: brl('20') });
    expect(entry.isBalanced()).toBe(true);
  });

  test('aritmética errada é rejeitada na factory', () => {
    expect(() => LedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('80'), balanceBefore: brl('100'), balanceAfter: brl('30') }))
      .toThrow(LedgerEntryNotBalancedError);
    expect(() => LedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('10'), balanceBefore: brl('0'), balanceAfter: brl('0') }))
      .toThrow(LedgerEntryNotBalancedError);
  });

  test('débito maior que o saldo anterior é rejeitado (saldo seria negativo)', () => {
    expect(() => LedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('10'), balanceBefore: brl('5'), balanceAfter: brl('0') }))
      .toThrow(LedgerEntryNotBalancedError);
  });

  test('valor zero é rejeitado', () => {
    expect(() => LedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0'), balanceBefore: brl('1'), balanceAfter: brl('1') }))
      .toThrow(InvalidMoneyError);
  });

  test('moedas diferentes são rejeitadas', () => {
    expect(() => LedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: Money.fromString('1', 'USD'), balanceBefore: brl('0'), balanceAfter: brl('1') }))
      .toThrow(CurrencyMismatchError);
  });
});

describe('LedgerEntry.rehydrate', () => {
  const entry = LedgerEntry.rehydrate({ ...base, direction: LedgerDirection.Credit, money: brl('1'), balanceBefore: brl('0'), balanceAfter: brl('1') });

  test('reconstrói o estado persistido', () => {
    expect(entry).toBeInstanceOf(LedgerEntry);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('imutável: sem setters nem métodos de transição, instância congelada', () => {
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).sort()).toEqual(['constructor', 'isBalanced']);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
