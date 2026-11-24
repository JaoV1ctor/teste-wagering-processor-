import { randomUUID } from 'node:crypto';
import type { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { integrationEventsFor } from './integration-events';
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
   * Saldo inicial > 0 gera a transação interna OPENING, o lançamento CREDIT e os eventos (`WagerTransactionProcessed` e
   * `WalletBalanceChanged`, porque o saldo muda) na MESMA transação SQL. Ordem de escrita: wallet -> transação -> ledger -> outbox.
   * Wallet duplicada falha no primeiro INSERT: nada é gravado, nem evento.
   */
  async execute(input: CreateWalletInput): Promise<Wallet> {
    const now = this.clock();
    const openingTransactionId = this.newId();
    const { wallet, openingEntry } = Wallet.create({
      id: this.newId(), playerId: input.playerId, initialBalance: input.initialBalance,
      openingTransactionId, openingEntryId: this.newId(), now,
    });

    await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
      await wallets.add(wallet);
      if (!openingEntry) return;
      const opening = openingTransaction(wallet, openingTransactionId, now);
      await transactions.add(opening);
      await ledger.add(openingEntry);
      // Sem origem (nem header nem mensagem), o correlationId é o id da transação, como no reprocesso do worker.
      const events = integrationEventsFor({
        transaction: opening, wallet, entry: openingEntry, previousStatus: WagerTransactionStatus.Pending, correlationId: undefined, at: now, newId: this.newId,
      });
      for (const event of events) await outbox.add(OutboxMessage.enqueue(event));
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
