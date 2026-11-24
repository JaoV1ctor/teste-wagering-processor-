import { InvalidIntegrationEventError } from '../errors';
import type { MoneyProps } from '../money';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';
import { type WagerTransactionEventData, wagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  /** Saldo da wallet depois de aplicar a transação (em `LOSS`, o saldo inalterado). */
  balance: MoneyProps;
}

/** Qualquer transação aplicada, inclusive `LOSS` (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed || transaction.observedBalance === undefined) {
      throw new InvalidIntegrationEventError(`WagerTransactionProcessed exige transação PROCESSED, recebeu ${transaction.status}`);
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: { ...wagerTransactionEventData(transaction), balance: transaction.observedBalance.toProps() },
    });
  }
}
