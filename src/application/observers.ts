import type { WagerTransaction } from '../domain/wager-transaction';

/** Quem e de onde: só identificadores, nunca o payload. É tudo o que o log e as métricas do processamento precisam. */
export interface ProcessingContext {
  providerId: string;
  walletId: string;
  /** Header `x-correlation-id` (HTTP) ou `messageId` (SQS). Ausente: quem observa usa o id da transação. */
  correlationId: string | undefined;
  /** Só no caminho SQS. */
  messageId: string | undefined;
}

/**
 * O que uma execução do `ProcessWagerTransactionUseCase` informa DEPOIS do commit (e só quando terminou com resultado; erro sobe como exceção):
 *  - `new`: transação decidida agora (PROCESSED, REJECTED ou PENDING_REFERENCE);
 *  - `replay`: mesma chave e mesmo payload, devolveu o resultado já gravado;
 *  - `duplicate-message`: o inbox já tinha esta mensagem; nada foi feito.
 */
export type ProcessingReport =
  | { outcome: 'new' | 'replay'; transaction: WagerTransaction; context: ProcessingContext; durationSeconds: number }
  | { outcome: 'duplicate-message'; context: ProcessingContext; durationSeconds: number };

/** O caso de uso não conhece log nem métrica; quem implementa decide o que fazer com o relatório. */
export interface ProcessingObserver {
  completed(report: ProcessingReport): void;
}

export const NO_PROCESSING_OBSERVER: ProcessingObserver = { completed: () => undefined };

/** Resultado de uma reconciliação (README §9). Dinheiro como string decimal; `difference` pode ser negativa, por isso não é `Money`. */
export interface WalletReconciliation {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationObserver {
  /** Chamado a cada reconciliação, consistente ou não. Divergência nunca é corrigida: quem observa a registra. */
  checked(result: WalletReconciliation, context: { correlationId: string | undefined }): void;
}
