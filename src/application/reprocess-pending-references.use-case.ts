import { randomUUID } from 'node:crypto';
import { OutboxMessage } from '../domain/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { WalletNotFoundError } from './errors';
import { integrationEventsFor } from './integration-events';
import type { ClaimedPendingReference, UnitOfWork } from './ports';
import { settleLocked } from './settle-locked-transaction';

export const DEFAULT_REPROCESS_BATCH_SIZE = 20;
/** Quanto uma transação reivindicada fica "reservada" ao worker. Bem acima de um reprocesso normal (dezenas de ms), para não ser reivindicada em dobro. */
export const DEFAULT_LEASE_MS = 30_000;

export type ReprocessOutcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

export interface ReprocessSummary {
  claimed: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
  failed: number;
}

export interface ReprocessOptions {
  /** Obrigatório de propósito: uma falha por transação nunca pode ser engolida. Quem monta o worker decide registrar ou relançar. */
  onError: (error: unknown, context: ClaimedPendingReference) => void;
  /** Chamado DEPOIS do commit quando a transação saiu de PENDING_REFERENCE para PROCESSED ou REJECTED (reagendar não chama). Só observação. */
  onSettled?: (transaction: WagerTransaction) => void;
  clock?: () => Date;
  newId?: () => string;
  random?: () => number;
  batchSize?: number;
  leaseMs?: number;
}

/**
 * Worker de PENDING_REFERENCE. `runOnce()` é uma passada: reivindica as vencidas por lease (outra transação, curta)
 * e reprocessa cada uma em uma transação normal, na MESMA ordem de locks do caso de uso de submissão: wallet primeiro,
 * depois relê a transação (outro processo pode tê-la resolvido), decide com `settleLocked` e grava transação -> wallet -> ledger -> outbox.
 * Correto com N instâncias: o claim entrega lotes disjuntos e o lock da wallet serializa o resto.
 */
export class ReprocessPendingReferencesUseCase {
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly random: (() => number) | undefined;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly onError: ReprocessOptions['onError'];
  private readonly onSettled: ((transaction: WagerTransaction) => void) | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    { onError, onSettled, clock = () => new Date(), newId = randomUUID, random, batchSize = DEFAULT_REPROCESS_BATCH_SIZE, leaseMs = DEFAULT_LEASE_MS }: ReprocessOptions,
  ) {
    this.onError = onError;
    this.onSettled = onSettled;
    this.clock = clock;
    this.newId = newId;
    this.random = random;
    this.batchSize = batchSize;
    this.leaseMs = leaseMs;
  }

  async runOnce(): Promise<ReprocessSummary> {
    const now = this.clock();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const claimed = await this.uow.run(({ transactions }) => transactions.claimDuePendingReference(now, this.batchSize, leaseUntil));

    const summary: ReprocessSummary = { claimed: claimed.length, processed: 0, rejected: 0, rescheduled: 0, skipped: 0, failed: 0 };
    // Em sequência: uma wallet com várias pendências não disputa o próprio lock consigo mesma.
    for (const item of claimed) {
      try {
        summary[await this.reprocessOne(item)] += 1;
      } catch (error) {
        summary.failed += 1;
        this.onError(error, item); // fica PENDING_REFERENCE; volta a ser elegível quando o lease vencer
      }
    }
    return summary;
  }

  async reprocessOne({ id, walletId }: ClaimedPendingReference): Promise<ReprocessOutcome> {
    // O resultado sai da transação junto com a transação de domínio: `run` pode reexecutar `work`, então nada é guardado fora dele.
    const { outcome, transaction } = await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
      const wallet = await wallets.lockWallet(walletId); // primeira instrução que toca a wallet
      if (!wallet) throw new WalletNotFoundError(walletId);

      const transaction = await transactions.findById(id);
      if (transaction?.status !== WagerTransactionStatus.PendingReference) return { outcome: 'skipped' as const, transaction: undefined };

      const now = this.clock();
      const entry = await settleLocked({ transactions }, wallet, transaction, { entryId: this.newId(), at: now, random: this.random });
      await transactions.update(transaction);
      if (entry) {
        await wallets.saveBalance(wallet);
        await ledger.add(entry);
      }
      // Sem origem (nem header nem mensagem): o correlationId é o id da transação. Reagendar quem já estava pendente não gera evento.
      const events = integrationEventsFor({
        transaction, wallet, entry, previousStatus: WagerTransactionStatus.PendingReference, correlationId: undefined, at: now, newId: this.newId,
      });
      for (const event of events) await outbox.add(OutboxMessage.enqueue(event));
      return { outcome: outcomeOf(transaction.status), transaction };
    });
    if (transaction && outcome !== 'rescheduled') this.onSettled?.(transaction); // só depois do commit
    return outcome;
  }
}

function outcomeOf(status: WagerTransactionStatus): Exclude<ReprocessOutcome, 'skipped'> {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 'processed';
    case WagerTransactionStatus.Rejected:
      return 'rejected';
    case WagerTransactionStatus.PendingReference:
      return 'rescheduled';
    default:
      throw new Error(`Estado inesperado após reprocessar: ${status}`);
  }
}
