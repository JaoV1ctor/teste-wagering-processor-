import { InvalidIntegrationEventError } from '../errors';
import type { LedgerDirection, LedgerEntry } from '../ledger-entry';
import type { MoneyProps } from '../money';
import type { Wallet } from '../wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** `version` da wallet já com esta mudança: sobe 1 a cada alteração de saldo, então o consumidor ordena e detecta lacunas por ela. */
  walletVersion: number;
}

/** SOMENTE quando o saldo muda (há um lançamento): nunca em `LOSS`, nunca em rejeição. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /** `wallet` é a wallet JÁ alterada (com a `version` nova) e `entry`, o lançamento que a alterou. */
  static from(wallet: Wallet, entry: LedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new InvalidIntegrationEventError('O lançamento pertence a outra wallet');
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toProps(),
        balanceBefore: entry.balanceBefore.toProps(),
        balanceAfter: entry.balanceAfter.toProps(),
        walletVersion: wallet.version,
      },
    });
  }
}
