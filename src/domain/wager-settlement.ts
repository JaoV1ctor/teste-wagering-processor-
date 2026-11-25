import { InsufficientBalanceError, InvalidWagerTransactionError, MoneyOverflowError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection, type LedgerEntry } from './ledger-entry';
import { hasExhaustedReferenceAttempts, referenceRetryDelayMs } from './reference-retry-policy';
import { referenceableKinds, type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import type { Wallet } from './wallet';

const K = WagerTransactionKind;

/** Tudo o que a liquidação precisa e o domínio não pode buscar sozinho: ids, relógio, aleatoriedade e o que foi lido do banco. */
export interface SettlementContext {
  entryId: string;
  at: Date;
  /** Transação já resolvida por (providerId, referenceExternalTransactionId); `undefined` se ainda não existe. */
  reference?: WagerTransaction | undefined;
  /** Já existe reversão efetiva (REFUND/ROLLBACK PROCESSED) da referência. Só importa para REFUND/ROLLBACK. */
  referenceAlreadyReversed?: boolean | undefined;
  /** Jitter do reagendamento; injetável para os testes serem determinísticos. */
  random?: (() => number) | undefined;
}

/**
 * Liquida uma transação PENDING ou PENDING_REFERENCE contra a wallet e a deixa em um destes estados:
 *   PROCESSED (BET debita, WIN credita, LOSS só registra, REFUND/ROLLBACK aplicam o inverso da referência),
 *   REJECTED com um `failureCode` (divergência de player/moeda, regras da referência, saldo), ou
 *   PENDING_REFERENCE quando a referência ainda não existe (reagendada com backoff; esgotado o limite, REJECTED/REFERENCE_NOT_FOUND).
 * Devolve o lançamento quando o saldo mudou. Em rejeição ou espera a wallet fica intacta.
 * Pré-condição: a wallet está travada por quem chama. OPENING (interna) não é liquidada aqui.
 */
export function settleWager(wallet: Wallet, transaction: WagerTransaction, context: SettlementContext): LedgerEntry | undefined {
  const { at } = context;
  const divergence = divergenceFrom(wallet, transaction);
  if (divergence) {
    transaction.reject(divergence, wallet.balance, at);
    return undefined;
  }
  if (transaction.kind === K.Opening) throw new InvalidWagerTransactionError('OPENING é interna e não é liquidada aqui');
  if (transaction.referenceExternalTransactionId === undefined) return post(wallet, transaction, undefined, context);

  const { reference } = context;
  // Referência ausente, ou ainda ela própria pendente: não há o que validar nem reverter; tenta de novo mais tarde.
  if (reference === undefined || reference.status === WagerTransactionStatus.PendingReference) {
    awaitReference(wallet, transaction, context);
    return undefined;
  }
  const violation = referenceViolation(transaction, reference, context.referenceAlreadyReversed === true);
  if (violation) {
    transaction.reject(violation, wallet.balance, at);
    return undefined;
  }
  return post(wallet, transaction, reference, context);
}

/** Identidade antes de moeda: se os dois divergem, o provedor corrige primeiro o player. */
function divergenceFrom(wallet: Wallet, transaction: WagerTransaction): FailureCode | undefined {
  if (transaction.playerId !== wallet.playerId) return FailureCode.PlayerMismatch;
  if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
  return undefined;
}

/**
 * Regras da referência, na ordem em que o provedor as corrige: de quem é a transação, que tipo é, se foi aplicada, se o valor
 * confere e se já foi revertida. A primeira violação decide.
 */
function referenceViolation(transaction: WagerTransaction, reference: WagerTransaction, alreadyReversed: boolean): FailureCode | undefined {
  const sameOwner =
    reference.providerId === transaction.providerId && reference.playerId === transaction.playerId && reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId && reference.money.currency === transaction.money.currency;
  if (!sameOwner) return FailureCode.ReferenceMismatch;
  if (!referenceableKinds(transaction.kind).includes(reference.kind)) return FailureCode.InvalidReferenceKind;
  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
  if (!transaction.requiresReference()) return undefined; // WIN/LOSS têm valor próprio; só as reversões repetem o da referência
  if (!transaction.money.equals(reference.money)) return FailureCode.AmountMismatch;
  if (alreadyReversed) return FailureCode.AlreadyReversed;
  return undefined;
}

/** Aplica o efeito no saldo (ou nenhum, no LOSS) e fecha a transação. Saldo curto ou estouro de NUMERIC(19,2) viram rejeição, nunca exceção. */
function post(wallet: Wallet, transaction: WagerTransaction, reference: WagerTransaction | undefined, { entryId, at }: SettlementContext): LedgerEntry | undefined {
  const link = reference === undefined ? {} : { referenceTransactionId: reference.id };
  if (!transaction.affectsBalance()) {
    transaction.markProcessed({ observedBalance: wallet.balance, at, ...link });
    return undefined;
  }

  const direction = transaction.ledgerDirectionFor(reference);
  const posting = { entryId, transactionId: transaction.id, at };
  let entry: LedgerEntry;
  try {
    entry = direction === LedgerDirection.Debit ? wallet.debit(transaction.money, posting) : wallet.credit(transaction.money, posting);
  } catch (error) {
    const code = rejectionFor(error, transaction.kind);
    if (code === undefined) throw error;
    transaction.reject(code, wallet.balance, at);
    return undefined;
  }
  transaction.markProcessed({ observedBalance: wallet.balance, at, ...link });
  return entry;
}

/** Débito sem saldo: BET é INSUFFICIENT_BALANCE; reversão é REVERSAL_WOULD_OVERDRAW. Crédito acima do limite: BALANCE_LIMIT_EXCEEDED. */
function rejectionFor(error: unknown, kind: WagerTransactionKind): FailureCode | undefined {
  if (error instanceof InsufficientBalanceError) return kind === K.Bet ? FailureCode.InsufficientBalance : FailureCode.ReversalWouldOverdraw;
  if (error instanceof MoneyOverflowError) return FailureCode.BalanceLimitExceeded;
  return undefined;
}

function awaitReference(wallet: Wallet, transaction: WagerTransaction, { at, random = Math.random }: SettlementContext): void {
  if (hasExhaustedReferenceAttempts(transaction.attempts)) {
    transaction.reject(FailureCode.ReferenceNotFound, wallet.balance, at);
    return;
  }
  const nextAttemptAt = new Date(at.getTime() + referenceRetryDelayMs(transaction.attempts + 1, random));
  transaction.markPendingReference(nextAttemptAt, at);
}
