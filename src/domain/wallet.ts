import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from './errors';
import { LedgerDirection, LedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação interna OPENING que justifica o saldo inicial. */
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

/** Identifica a transação e o instante de uma movimentação; o lançamento nasce junto com o saldo novo. */
export interface Posting {
  entryId: string;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate root. O saldo só muda via `debit`/`credit`, que devolvem o lançamento correspondente:
 * não existe alteração de saldo sem lançamento. `version` sobe somente quando o saldo muda.
 * A exclusão mútua entre processos é do banco (lock da wallet); aqui só vivem as invariantes.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre a wallet com `version` 1. Saldo inicial > 0 gera o lançamento CREDIT de abertura (0 -> saldo). */
  static create(props: CreateWalletProps): { wallet: Wallet; openingEntry: LedgerEntry | undefined } {
    const { initialBalance: balance, now } = props;
    const wallet = new Wallet(props.id, props.playerId, balance.currency, balance, 1, now, now);
    const openingEntry = balance.isPositive()
      ? LedgerEntry.create({
          id: props.openingEntryId, walletId: props.id, transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit, money: balance, balanceBefore: Money.zero(balance.currency),
          balanceAfter: balance, createdAt: now,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money, posting: Posting): LedgerEntry {
    this.assertOperable(amount);
    if (amount.isGreaterThan(this._balance)) throw new InsufficientBalanceError();
    return this.apply(LedgerDirection.Debit, amount, this._balance.subtract(amount), posting);
  }

  credit(amount: Money, posting: Posting): LedgerEntry {
    this.assertOperable(amount);
    return this.apply(LedgerDirection.Credit, amount, this._balance.add(amount), posting);
  }

  toState(): WalletState {
    return {
      id: this.id, playerId: this.playerId, currency: this.currency, balance: this._balance,
      version: this._version, createdAt: this.createdAt, updatedAt: this._updatedAt,
    };
  }

  /** O lançamento é criado (e validado) antes de qualquer mutação: se algo lançar, o estado fica intacto. */
  private apply(direction: LedgerDirection, amount: Money, balanceAfter: Money, posting: Posting): LedgerEntry {
    const entry = LedgerEntry.create({
      id: posting.entryId, walletId: this.id, transactionId: posting.transactionId, direction,
      money: amount, balanceBefore: this._balance, balanceAfter, createdAt: posting.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = posting.at;
    return entry;
  }

  private assertOperable(amount: Money): void {
    if (amount.currency !== this.currency) throw new CurrencyMismatchError(this.currency, amount.currency);
    if (!amount.isPositive()) throw new InvalidMoneyError('Movimentação exige valor maior que zero');
  }
}
