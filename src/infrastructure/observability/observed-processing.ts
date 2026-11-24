import type { ProcessingObserver, ProcessingReport } from '../../application/observers';
import type { logJson } from './json-log';
import type { Metrics } from './metrics';

/**
 * Liga o relatório do caso de uso a métricas e log. Campos do log: só identificadores (correlationId, messageId, transactionId, walletId,
 * providerId) e o resultado (kind, status, failureCode). Nunca o corpo, valores, chave de idempotência, playerId, rodada ou jogo.
 */
export class ObservedProcessing implements ProcessingObserver {
  constructor(
    private readonly metrics: Metrics,
    private readonly log: typeof logJson,
  ) {}

  completed(report: ProcessingReport): void {
    const { context, durationSeconds } = report;
    this.metrics.observeProcessing(durationSeconds);
    const ids = { messageId: context.messageId, walletId: context.walletId, providerId: context.providerId };

    if (report.outcome === 'duplicate-message') {
      this.metrics.duplicate();
      this.log('info', 'wager_message_duplicate', { correlationId: context.correlationId ?? context.messageId, ...ids });
      return;
    }

    const { transaction } = report;
    const fields = {
      correlationId: context.correlationId ?? transaction.id, transactionId: transaction.id, ...ids,
      kind: transaction.kind, status: transaction.status, failureCode: transaction.failureCode,
    };
    if (report.outcome === 'replay') {
      this.metrics.duplicate();
      this.log('info', 'wager_transaction_replayed', fields);
      return;
    }
    this.metrics.transactionSettled(transaction.status, transaction.kind);
    this.log('info', 'wager_transaction_processed', fields);
  }
}
