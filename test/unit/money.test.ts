import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

describe('Money.fromString', () => {
  test.each([
    ['0', 0n],
    ['0.00', 0n],
    ['10', 1000n],
    ['10.5', 1050n],
    ['10.50', 1050n],
    ['0.01', 1n],
    ['99999999999999.99', 9999999999999999n],
    ['99999999999999999.99', 9999999999999999999n], // máximo de NUMERIC(19,2), acima de Number.MAX_SAFE_INTEGER
  ])('aceita %s', (input, cents) => {
    expect(Money.fromString(input, 'BRL').cents).toBe(cents);
  });

  test.each(['10.005', '10.001', '0.999', '1.2345'])('rejeita mais de 2 casas decimais: %s', (input) => {
    expect(() => Money.fromString(input, 'BRL')).toThrow(InvalidMoneyError);
  });

  test.each([
    '', ' ', 'abc', '-1', '-0.01', '+1', '1e3', '1,50', '1.', '.5', '1.5.0', ' 10.00', '10.00 ', '0x10', 'NaN', 'Infinity',
    '100000000000000000.00', // 18 dígitos inteiros: não cabe em NUMERIC(19,2)
  ])('rejeita entrada inválida: %p', (input) => {
    expect(() => Money.fromString(input, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('rejeita entrada que não é string (number vindo de JSON)', () => {
    expect(() => Money.fromString(10.5 as unknown as string, 'BRL')).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'B1L'])('rejeita moeda inválida: %p', (currency) => {
    expect(() => Money.fromString('1.00', currency)).toThrow(InvalidMoneyError);
  });
});

describe('Money', () => {
  test('toString sempre com 2 casas', () => {
    expect(Money.fromString('5', 'BRL').toString()).toBe('5.00');
    expect(Money.fromCents(5n, 'BRL').toString()).toBe('0.05');
    expect(Money.fromCents(123456n, 'BRL').toString()).toBe('1234.56');
    expect(Money.zero('BRL').toString()).toBe('0.00');
  });

  test('toProps usa string decimal, nunca number', () => {
    expect(Money.fromString('25', 'BRL').toProps()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('fromCents rejeita negativo e acima do máximo', () => {
    expect(() => Money.fromCents(-1n, 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.fromCents(10n ** 19n, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('add e subtract são exatos (0.10 + 0.20 === 0.30)', () => {
    const a = Money.fromString('0.10', 'BRL');
    const b = Money.fromString('0.20', 'BRL');
    expect(a.add(b).equals(Money.fromString('0.30', 'BRL'))).toBe(true);
    expect(b.subtract(a).toString()).toBe('0.10');
  });

  test('subtract não produz valor negativo', () => {
    expect(() => Money.fromString('1', 'BRL').subtract(Money.fromString('2', 'BRL'))).toThrow(InvalidMoneyError);
  });

  test('add não ultrapassa o máximo de NUMERIC(19,2)', () => {
    const max = Money.fromCents(10n ** 19n - 1n, 'BRL');
    expect(() => max.add(Money.fromCents(1n, 'BRL'))).toThrow(InvalidMoneyError);
  });

  test('moedas diferentes: add, subtract e comparação lançam CurrencyMismatchError', () => {
    const brl = Money.fromString('1', 'BRL');
    const usd = Money.fromString('1', 'USD');
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isGreaterThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('equals considera valor e moeda; isZero e isPositive', () => {
    expect(Money.fromString('1', 'BRL').equals(Money.fromString('1.00', 'BRL'))).toBe(true);
    expect(Money.fromString('1', 'BRL').equals(Money.fromString('1', 'USD'))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.fromCents(1n, 'BRL').isPositive()).toBe(true);
  });
});
