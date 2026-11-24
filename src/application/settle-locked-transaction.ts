import type { LedgerEntry } from '../domain/ledger-entry';
import { settleWager } from '../domain/wager-settlement';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { Repositories } from './ports';

export interface SettleLockedOptions {
  entryId: string;
  at: Date;
  random?: (() => number) | undefined;
}

/**
 * Liquida `transaction` com a wallet JÁ travada: resolve a referência por (providerId, referenceExternalTransactionId) e a existência
 * de reversão efetiva, e delega a decisão ao domínio. Compartilhado pela submissão (HTTP/SQS) e pelo worker de PENDING_REFERENCE,
 * para que a regra seja uma só. Só LÊ; quem chama grava o resultado (transação, saldo, ledger) na ordem wallet -> transação -> ledger.
 * Ler a referência sem lock é seguro: ela só muda sob o lock desta mesma wallet (ou é de outra wallet e a regra a rejeita).
 */
export async function settleLocked(
  { transactions }: Pick<Repositories, 'transactions'>,
  wallet: Wallet,
  transaction: WagerTransaction,
  { entryId, at, random }: SettleLockedOptions,
): Promise<LedgerEntry | undefined> {
  const referenceId = transaction.referenceExternalTransactionId;
  const reference = referenceId === undefined ? undefined : await transactions.findByProviderExternalId(transaction.providerId, referenceId);
  const referenceAlreadyReversed =
    reference?.status === WagerTransactionStatus.Processed && transaction.requiresReference()
      ? await transactions.hasEffectiveReversal(reference.id)
      : false;
  return settleWager(wallet, transaction, { entryId, at, reference, referenceAlreadyReversed, random });
}
