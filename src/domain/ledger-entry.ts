import { CurrencyMismatchError, InvalidMoneyError, LedgerEntryNotBalancedError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Lançamento imutável: só campos `readonly`, sem métodos de transição, instância congelada. */
export class LedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética: `balanceBefore ± money === balanceAfter`, com o valor > 0 e uma única moeda. */
  static create(state: LedgerEntryState): LedgerEntry {
    if (!state.money.isPositive()) throw new InvalidMoneyError('Lançamento exige valor maior que zero');
    for (const other of [state.balanceBefore, state.balanceAfter]) {
      if (other.currency !== state.money.currency) throw new CurrencyMismatchError(state.money.currency, other.currency);
    }
    const entry = LedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) throw new LedgerEntryNotBalancedError();
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: LedgerEntryState): LedgerEntry {
    return new LedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction,
      state.money, state.balanceBefore, state.balanceAfter, state.createdAt,
    );
  }

  isBalanced(): boolean {
    const delta = this.direction === LedgerDirection.Credit ? this.money.cents : -this.money.cents;
    return this.balanceBefore.cents + delta === this.balanceAfter.cents;
  }
}
