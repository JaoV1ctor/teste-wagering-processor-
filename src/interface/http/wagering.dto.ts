import { z } from 'zod';
import type { ProcessWagerResult } from '../../application/process-wager-transaction.use-case';
import type { MoneyProps } from '../../domain/money';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { moneySchema } from './wallets.dto';

const identifier = z.string().min(1).max(255);

/** Nesta fase só BET, WIN e LOSS. OPENING é interno (SPEC §3.6); REFUND/ROLLBACK e referências são da Fase 3. */
export const SubmitTransactionBody = z.strictObject({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.enum([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss]),
  money: moneySchema.refine((money) => money.isPositive(), { message: 'Valor deve ser maior que zero' }),
  referenceExternalTransactionId: z.never({ error: 'referenceExternalTransactionId ainda não é suportado' }).optional(),
});

export const IdempotencyKeyHeader = z.string().trim().min(1).max(255);
export const TransactionIdParam = z.uuid();
export const ProviderTransactionParams = z.strictObject({ providerId: identifier, externalTransactionId: identifier });

/** SPEC §5.2: 201 processada, 422 rejeição de negócio, 202 aguardando referência. FAILED é terminal e não se reenvia: 422. */
export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    case WagerTransactionStatus.Pending:
      throw new Error('PENDING nunca é uma resposta: a transação só é gravada no estado final');
  }
}

export interface SubmitResponse {
  transactionId: string;
  status: string;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: string;
}

export interface TransactionResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

/** `balance` é o saldo observado ao decidir: é o que um replay devolve (SPEC §3.2). */
export const toSubmitResponse = ({ transaction, idempotentReplay }: ProcessWagerResult): SubmitResponse => ({
  transactionId: transaction.id,
  status: transaction.status,
  balance: transaction.observedBalance?.toProps() ?? null,
  idempotentReplay,
  ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
});

export const toTransactionResponse = (transaction: WagerTransaction): TransactionResponse => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toProps(),
  status: transaction.status,
  failureCode: transaction.failureCode ?? null,
  balance: transaction.observedBalance?.toProps() ?? null,
  createdAt: transaction.createdAt.toISOString(),
  processedAt: transaction.processedAt?.toISOString() ?? null,
});
