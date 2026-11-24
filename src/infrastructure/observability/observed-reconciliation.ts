import type { ReconciliationObserver, WalletReconciliation } from '../../application/observers';
import type { logJson } from './json-log';
import type { Metrics } from './metrics';

/**
 * Divergência: métrica + log de ERRO com o walletId e a diferença (nunca os saldos). Consistente: só um log informativo.
 * Nenhum dos dois corrige nada; a decisão é humana.
 */
export class ObservedReconciliation implements ReconciliationObserver {
  constructor(
    private readonly metrics: Metrics,
    private readonly log: typeof logJson,
  ) {}

  checked(result: WalletReconciliation, { correlationId }: { correlationId: string | undefined }): void {
    const fields = { correlationId, walletId: result.walletId, checkedEntries: result.checkedEntries };
    if (result.consistent) {
      this.log('info', 'wallet_reconciled', fields);
      return;
    }
    this.metrics.reconciliationDiverged();
    this.log('error', 'wallet_reconciliation_diverged', { ...fields, difference: result.difference.amount });
  }
}
