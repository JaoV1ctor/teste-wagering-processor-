import type { ReconciliationObserver, WalletReconciliation } from './observers';
import { WalletNotFoundError } from './errors';
import type { UnitOfWork } from './ports';

export interface ReconcileWalletInput {
  walletId: string;
  /** Header `x-correlation-id`, só para ligar o log da divergência à requisição. */
  correlationId?: string | undefined;
}

/**
 * Reconciliação (README §9; SPEC §8.4): compara `wallets.balance` com a soma do ledger (CREDIT - DEBIT) e REPORTA. Nunca corrige: divergência vira
 * resposta (`consistent: false`), log de erro e métrica, e quem decide o que fazer é a operação. Só lê, sem lock da wallet: o repositório lê
 * saldo e ledger numa única instrução (um snapshot), então uma aposta concorrente nunca produz divergência que não existe.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly observer: ReconciliationObserver,
  ) {}

  async execute({ walletId, correlationId }: ReconcileWalletInput): Promise<WalletReconciliation> {
    const summary = await this.uow.read(({ ledger }) => ledger.summarize(walletId));
    if (!summary) throw new WalletNotFoundError(walletId);

    const money = (amount: string) => ({ amount, currency: summary.currency });
    const result: WalletReconciliation = {
      walletId,
      storedBalance: money(summary.storedBalance),
      calculatedBalance: money(summary.calculatedBalance),
      difference: money(summary.difference),
      consistent: summary.consistent,
      checkedEntries: summary.checkedEntries,
    };
    this.observer.checked(result, { correlationId });
    return result;
  }
}
