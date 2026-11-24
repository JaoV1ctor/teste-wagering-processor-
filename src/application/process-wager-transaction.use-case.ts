import { randomUUID } from 'node:crypto';
import type { Money } from '../domain/money';
import { settleWager } from '../domain/wager-settlement';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import { IdempotencyConflictError, WalletNotFoundError } from './errors';
import { computePayloadHash } from './payload-hash';
import type { UnitOfWork } from './ports';

/** Entrada única do caso de uso: HTTP hoje, SQS na Fase 4. Os campos de negócio entram no `payloadHash`; a chave não. */
export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/**
 * SPEC §6. Idempotência decidida pelo banco (UNIQUE), nunca por estado em memória.
 * Ordem de locks e escrita: wallet -> transação -> ledger. A transação nasce PENDING no domínio e é gravada UMA vez, no estado final.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const payloadHash = computePayloadHash({
      providerId: command.providerId, externalTransactionId: command.externalTransactionId, playerId: command.playerId,
      walletId: command.walletId, roundId: command.roundId, gameId: command.gameId, kind: command.kind, money: command.money.toProps(),
    });

    // Fast-path sem lock: replay não disputa a wallet. Só otimização; quem decide a corrida é o INSERT abaixo.
    const known = await this.uow.read(({ transactions }) => transactions.findByIdempotencyKey(command.idempotencyKey));
    if (known) return replayOf(known, payloadHash);

    return this.uow.run(async ({ wallets, transactions, ledger }) => {
      const wallet = await wallets.lockWallet(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId);

      const now = this.clock();
      const transaction = WagerTransaction.create({
        id: this.newId(), providerId: command.providerId, externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey, payloadHash, walletId: wallet.id, playerId: command.playerId, roundId: command.roundId,
        gameId: command.gameId, kind: command.kind, money: command.money, now,
      });
      const entry = settleWager(wallet, transaction, { entryId: this.newId(), at: now });

      if (!(await transactions.addIdempotent(transaction))) {
        // Outra requisição com a mesma chave commitou antes: nada do que decidimos em memória foi gravado.
        const winner = await transactions.findByIdempotencyKey(command.idempotencyKey);
        if (!winner) throw new Error('Chave de idempotência em conflito, mas a transação vencedora não está visível');
        return replayOf(winner, payloadHash);
      }
      if (entry) {
        await wallets.saveBalance(wallet);
        await ledger.add(entry);
      }
      return { transaction, idempotentReplay: false };
    });
  }
}

/** Mesma chave e mesmo payload é replay; mesma chave com payload diferente é conflito, nunca replay. */
function replayOf(existing: WagerTransaction, payloadHash: string): ProcessWagerResult {
  if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError();
  return { transaction: existing, idempotentReplay: true };
}
