import { InvalidIntegrationEventError } from '../domain/errors';
import type { IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import type { LedgerEntry } from '../domain/ledger-entry';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export interface IntegrationEventsInput {
  /** Transação já liquidada (estado final desta passada). */
  transaction: WagerTransaction;
  /** Wallet depois da liquidação (com a `version` nova, se o saldo mudou). */
  wallet: Wallet;
  /** Lançamento gerado, se o saldo mudou. */
  entry: LedgerEntry | undefined;
  /** Estado ANTES da liquidação: distingue a 1ª vez que fica pendente de um reagendamento do worker. */
  previousStatus: WagerTransactionStatus;
  /** Header `x-correlation-id` (HTTP) ou `messageId` (SQS). Sem origem (worker, HTTP sem header), vale o id da transação. */
  correlationId: string | undefined;
  at: Date;
  newId: () => string;
}

/**
 * Quais eventos nascem de uma liquidação (regra em docs/ARCHITECTURE.md, "Eventos"). Função pura; quem chama grava o resultado no outbox, na MESMA
 * transação SQL, como último passo (wallet -> transação -> ledger -> outbox).
 *  - PROCESSED: `Processed` (inclusive `LOSS`) e, só se o saldo mudou, `BalanceChanged`, causado pelo `Processed`.
 *  - REJECTED: `Rejected` (inclusive o limite de espera da referência esgotado); nunca `BalanceChanged`.
 *  - PENDING_REFERENCE: `PendingReference` só na 1ª vez; reagendar quem já estava pendente não gera evento.
 */
export function integrationEventsFor({ transaction, wallet, entry, previousStatus, correlationId, at, newId }: IntegrationEventsInput): IntegrationEvent<unknown>[] {
  const context = () => ({ eventId: newId(), correlationId: correlationId ?? transaction.id, occurredAt: at });

  switch (transaction.status) {
    case WagerTransactionStatus.Processed: {
      const processed = WagerTransactionProcessed.from(transaction, context());
      if (entry === undefined) return [processed];
      return [processed, WalletBalanceChanged.from(wallet, entry, { ...context(), causationId: processed.eventId })];
    }
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, context())];
    case WagerTransactionStatus.PendingReference:
      return previousStatus === WagerTransactionStatus.PendingReference ? [] : [WagerTransactionPendingReference.from(transaction, context())];
    default:
      throw new InvalidIntegrationEventError(`A liquidação não termina em ${transaction.status}`);
  }
}
