import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Maior valor de NUMERIC(19,2) em centavos: 17 dígitos inteiros + 2 decimais. */
const MAX_CENTS = 10n ** 19n - 1n;
const CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^(\d{1,17})(?:\.(\d{1,2}))?$/;

/**
 * Valor monetário imutável e não negativo: centavos em `bigint` + moeda.
 * Nunca usa `number`; as bordas trocam strings decimais ("10.50").
 */
export class Money {
  private constructor(
    readonly cents: bigint,
    readonly currency: string,
  ) {}

  static fromString(amount: string, currency: string): Money {
    assertCurrency(currency);
    if (typeof amount !== 'string') throw new InvalidMoneyError('Valor deve ser uma string decimal');
    const match = DECIMAL.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        /^\d+\.\d{3,}$/.test(amount) ? 'Valor aceita no máximo 2 casas decimais' : `Valor inválido: "${amount}"`,
      );
    }
    const [, whole = '', fraction = ''] = match;
    return new Money(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')), currency);
  }

  static fromCents(cents: bigint, currency: string): Money {
    assertCurrency(currency);
    if (cents < 0n || cents > MAX_CENTS) throw new InvalidMoneyError('Valor fora do intervalo de NUMERIC(19,2)');
    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return Money.fromCents(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents > other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  toProps(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal com exatamente 2 casas, ex.: "10.05". */
  toString(): string {
    return `${this.cents / 100n}.${(this.cents % 100n).toString().padStart(2, '0')}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}

function assertCurrency(currency: string): void {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError(`Moeda inválida: "${String(currency)}" (esperado 3 letras maiúsculas)`);
  }
}
