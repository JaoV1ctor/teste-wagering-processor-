import { InvalidIntegrationEventError } from '../errors';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';
import { type WagerTransactionEventData, wagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  /** Id, no provedor, da transação referenciada que ainda não chegou. */
  referenceExternalTransactionId: string;
}

/** A transação ficou aguardando a referência. Emitido uma vez, na 1ª vez que ela fica pendente; os reagendamentos não geram evento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId } = transaction;
    if (transaction.status !== WagerTransactionStatus.PendingReference || referenceExternalTransactionId === undefined) {
      throw new InvalidIntegrationEventError(`WagerTransactionPendingReference exige transação PENDING_REFERENCE, recebeu ${transaction.status}`);
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: { ...wagerTransactionEventData(transaction), referenceExternalTransactionId },
    });
  }
}
