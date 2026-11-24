import { randomUUID } from 'node:crypto';
import type { Money } from '../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { computePayloadHash } from './payload-hash';
import type { UnitOfWork } from './ports';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
}

const INTERNAL_PROVIDER = 'internal';

export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  /**
   * Saldo inicial > 0 gera a transação interna OPENING e o lançamento CREDIT na MESMA transação SQL.
   * Ordem de escrita: wallet -> transação -> ledger.
   */
  async execute(input: CreateWalletInput): Promise<Wallet> {
    const now = this.clock();
    const openingTransactionId = this.newId();
    const { wallet, openingEntry } = Wallet.create({
      id: this.newId(), playerId: input.playerId, initialBalance: input.initialBalance,
      openingTransactionId, openingEntryId: this.newId(), now,
    });

    await this.uow.run(async ({ wallets, transactions, ledger }) => {
      await wallets.add(wallet);
      if (openingEntry) {
        await transactions.add(openingTransaction(wallet, openingTransactionId, now));
        await ledger.add(openingEntry);
      }
    });
    return wallet;
  }
}

function openingTransaction(wallet: Wallet, id: string, now: Date): WagerTransaction {
  const externalTransactionId = `opening:${wallet.id}`;
  const kind = WagerTransactionKind.Opening;
  const transaction = WagerTransaction.create({
    id, providerId: INTERNAL_PROVIDER, externalTransactionId, idempotencyKey: externalTransactionId,
    payloadHash: computePayloadHash({
      providerId: INTERNAL_PROVIDER, externalTransactionId, playerId: wallet.playerId, walletId: wallet.id,
      roundId: 'opening', gameId: 'opening', kind, money: wallet.balance.toProps(),
    }),
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'opening', gameId: 'opening', kind, money: wallet.balance, now,
  });
  transaction.markProcessed({ observedBalance: wallet.balance, at: now });
  return transaction;
}
