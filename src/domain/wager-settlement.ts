import { InsufficientBalanceError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import type { LedgerEntry } from './ledger-entry';
import { type WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

/** Identificadores gerados fora do domínio, para a liquidação ser determinística e testável. */
export interface SettlementContext {
  entryId: string;
  at: Date;
}

/**
 * Liquida uma transação PENDING contra a wallet (SPEC §3.5, §3.8 e §4) e a deixa no estado final:
 *   BET debita, WIN credita, LOSS só registra; divergência de player/moeda e saldo insuficiente viram REJECTED.
 * Devolve o lançamento quando o saldo mudou. Em rejeição a wallet fica intacta e `observedBalance` guarda o saldo visto.
 * REFUND/ROLLBACK (Fase 3) e OPENING (interna) não são liquidadas aqui. Pré-condição: a wallet está travada por quem chama.
 */
export function settleWager(wallet: Wallet, transaction: WagerTransaction, { entryId, at }: SettlementContext): LedgerEntry | undefined {
  const divergence = divergenceFrom(wallet, transaction);
  if (divergence) {
    transaction.reject(divergence, wallet.balance, at);
    return undefined;
  }

  const posting = { entryId, transactionId: transaction.id, at };
  switch (transaction.kind) {
    case WagerTransactionKind.Loss:
      transaction.markProcessed({ observedBalance: wallet.balance, at });
      return undefined;
    case WagerTransactionKind.Win: {
      const entry = wallet.credit(transaction.money, posting);
      transaction.markProcessed({ observedBalance: wallet.balance, at });
      return entry;
    }
    case WagerTransactionKind.Bet:
      try {
        const entry = wallet.debit(transaction.money, posting);
        transaction.markProcessed({ observedBalance: wallet.balance, at });
        return entry;
      } catch (error) {
        if (!(error instanceof InsufficientBalanceError)) throw error;
        transaction.reject(FailureCode.InsufficientBalance, wallet.balance, at);
        return undefined;
      }
    default:
      throw new InvalidWagerTransactionError(`${transaction.kind} não é liquidada por settleWager`);
  }
}

/** Identidade antes de moeda: se os dois divergem, o provedor corrige primeiro o player. */
function divergenceFrom(wallet: Wallet, transaction: WagerTransaction): FailureCode | undefined {
  if (transaction.playerId !== wallet.playerId) return FailureCode.PlayerMismatch;
  if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
  return undefined;
}
