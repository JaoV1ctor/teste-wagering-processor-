import { InvalidIntegrationEventError } from '../errors';
import type { FailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';
import { type WagerTransactionEventData, wagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  /** Saldo da wallet visto na decisão; a rejeição não o altera. */
  balance: MoneyProps;
}

/** Transação rejeitada por regra de negócio, inclusive quando o limite de espera pela referência se esgota. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const { failureCode, observedBalance } = transaction;
    if (transaction.status !== WagerTransactionStatus.Rejected || failureCode === undefined || observedBalance === undefined) {
      throw new InvalidIntegrationEventError(`WagerTransactionRejected exige transação REJECTED, recebeu ${transaction.status}`);
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: { ...wagerTransactionEventData(transaction), failureCode, balance: observedBalance.toProps() },
    });
  }
}
