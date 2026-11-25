import { z } from 'zod';
import type { ProcessWagerResult } from '../../application/process-wager-transaction.use-case';
import type { MoneyProps } from '../../domain/money';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { moneySchema, textSchema, uuidSchema } from './wallets.dto';

const identifier = textSchema(255);

const K = WagerTransactionKind;
const SUBMITTABLE_KINDS = [K.Bet, K.Win, K.Loss, K.Refund, K.Rollback] as const;

export const wagerFields = {
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifier,
  gameId: identifier,
  /** OPENING é interno e não entra. */
  kind: z.enum(SUBMITTABLE_KINDS),
  money: moneySchema.refine((money) => money.isPositive(), { message: 'Valor deve ser maior que zero' }),
  referenceExternalTransactionId: identifier.optional(),
};

/**
 * `referenceExternalTransactionId`: obrigatório em REFUND/ROLLBACK, opcional em WIN/LOSS,
 * proibido em BET e nunca igual ao próprio id. Validado na borda para o erro ser 400 (HTTP) ou DLQ (SQS), não falha do domínio.
 */
export function checkReferenceRules(ctx: z.core.ParsePayload<{ kind: string; externalTransactionId: string; referenceExternalTransactionId?: string | undefined }>): void {
  const { kind, referenceExternalTransactionId: reference, externalTransactionId } = ctx.value;
  const reject = (message: string) => ctx.issues.push({ code: 'custom', message, input: ctx.value, path: ['referenceExternalTransactionId'] });
  if ((kind === K.Refund || kind === K.Rollback) && reference === undefined) reject(`${kind} exige referenceExternalTransactionId`);
  if (kind === K.Bet && reference !== undefined) reject('BET não aceita referenceExternalTransactionId');
  if (reference !== undefined && reference === externalTransactionId) reject('A transação não pode referenciar a si mesma');
}

export const SubmitTransactionBody = z.strictObject(wagerFields).check(checkReferenceRules);

export const IdempotencyKeyHeader = z.string().trim().pipe(textSchema(255));
/** Opcional: quem chama pode rastrear a requisição. Limite igual ao do `messageId` do SQS, que cumpre o mesmo papel. */
export const CorrelationIdHeader = z.string().trim().min(1).max(128).optional();
export const TransactionIdParam = uuidSchema;
export const ProviderTransactionParams = z.strictObject({ providerId: identifier, externalTransactionId: identifier });

/** 201 processada, 422 rejeição de negócio, 202 aguardando referência. FAILED é terminal e não se reenvia: 422. */
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

/** `balance` é o saldo observado ao decidir: é o que um replay devolve. */
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
