import { randomUUID } from 'node:crypto';
import { InboxMessage } from '../domain/inbox-message';
import type { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { IdempotencyConflictError, InboxPayloadConflictError, WalletNotFoundError } from './errors';
import { integrationEventsFor } from './integration-events';
import { NO_PROCESSING_OBSERVER, type ProcessingObserver, type ProcessingReport } from './observers';
import { computePayloadHash } from './payload-hash';
import type { Repositories, UnitOfWork } from './ports';
import { settleLocked } from './settle-locked-transaction';

/** Entrada única do caso de uso, para HTTP e SQS. Os campos de negócio entram no `payloadHash`; a chave não. */
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
  /** id no provedor da transação referenciada: obrigatório em REFUND/ROLLBACK, opcional em WIN/LOSS, proibido em BET. */
  referenceExternalTransactionId?: string;
  /** Origem do processamento nos eventos: header `x-correlation-id` (HTTP) ou `messageId` (SQS). Não entra no `payloadHash`. Ausente: o id da transação. */
  correlationId?: string;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/** De onde veio a mensagem (entrada SQS). A chave `(consumerName, messageId)` do inbox deduplica entregas repetidas. */
export interface MessageOrigin {
  consumerName: string;
  messageId: string;
}

/** A mensagem já tinha sido processada por este consumidor: nada foi feito e o chamador pode confirmá-la (ack). */
export interface DuplicateMessageResult {
  duplicateMessage: true;
}

/**
 * Idempotência decidida pelo banco (UNIQUE), nunca por estado em memória.
 * Ordem de locks e escrita: wallet -> transação -> ledger -> outbox. A transação nasce PENDING no domínio e é gravada UMA vez, no estado final
 * (PROCESSED, REJECTED ou PENDING_REFERENCE, quando a referência ainda não chegou; o worker a resolve depois).
 * Os eventos de integração entram no outbox como ÚLTIMO passo da MESMA transação SQL: sem commit, não há evento.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly observer: ProcessingObserver = NO_PROCESSING_OBSERVER,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult>;
  async execute(command: ProcessWagerCommand, origin: MessageOrigin): Promise<ProcessWagerResult | DuplicateMessageResult>;
  async execute(command: ProcessWagerCommand, origin?: MessageOrigin): Promise<ProcessWagerResult | DuplicateMessageResult> {
    const started = performance.now();
    const result = await this.run(command, origin);
    // Depois do commit: o observador nunca participa da transação.
    this.observer.completed(reportOf(command, origin, result, (performance.now() - started) / 1000));
    return result;
  }

  private async run(command: ProcessWagerCommand, origin: MessageOrigin | undefined): Promise<ProcessWagerResult | DuplicateMessageResult> {
    const payloadHash = computePayloadHash({
      providerId: command.providerId, externalTransactionId: command.externalTransactionId, playerId: command.playerId,
      walletId: command.walletId, roundId: command.roundId, gameId: command.gameId, kind: command.kind, money: command.money.toProps(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    // Fast-path sem lock: replay não disputa a wallet. Só otimização; quem decide a corrida é o INSERT abaixo.
    const known = await this.uow.read(({ transactions }) => transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey));
    // Sem mensagem (HTTP) o replay não escreve nada. Por mensagem ele ainda passa pelo inbox: a messageId precisa ficar registrada.
    if (known && !origin) return replayOf(known, payloadHash);

    return this.uow.run(async (repositories) => {
      // O inbox entra na MESMA transação, antes do lock da wallet (não toca a wallet, então a ordem de locks não muda).
      const inbox = origin ? await this.receive(repositories, origin, payloadHash) : undefined;
      if (inbox === 'duplicate') return { duplicateMessage: true as const };

      // No replay a transação curta só grava o inbox: não há lock de wallet.
      const result = known ? replayOf(known, payloadHash) : await this.processLocked(repositories, command, payloadHash);
      if (inbox) {
        inbox.markProcessed(this.clock());
        await repositories.inbox.markProcessed(inbox);
      }
      return result;
    });
  }

  /** `duplicate` se o consumidor já processou esta mensagem (mudar só metadados também é duplicata); lança se o mesmo `messageId` chegou com outro hash dos campos de negócio. */
  private async receive({ inbox }: Repositories, origin: MessageOrigin, payloadHash: string): Promise<InboxMessage | 'duplicate'> {
    const message = InboxMessage.receive({ ...origin, payloadHash, now: this.clock() });
    if (await inbox.addIfAbsent(message)) return message;
    const existing = await inbox.find(origin.consumerName, origin.messageId);
    if (!existing) throw new Error('Mensagem do inbox em conflito, mas a linha vencedora não está visível');
    if (!existing.matchesPayload(payloadHash)) throw new InboxPayloadConflictError(origin.messageId);
    return 'duplicate';
  }

  private async processLocked(
    { wallets, transactions, ledger, outbox }: Repositories,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const wallet = await wallets.lockWallet(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);

    const now = this.clock();
    const transaction = WagerTransaction.create({
      id: this.newId(), providerId: command.providerId, externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey, payloadHash, walletId: wallet.id, playerId: command.playerId, roundId: command.roundId,
      gameId: command.gameId, kind: command.kind, money: command.money, now,
      ...(command.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
    });
    // Lê a referência (se houver) e decide; nada é gravado ainda. Com a wallet travada, o que lemos não muda até o commit.
    const entry = await settleLocked({ transactions }, wallet, transaction, { entryId: this.newId(), at: now });

    if (!(await transactions.addIdempotent(transaction))) {
      // Outra requisição do mesmo provedor com a mesma chave commitou antes: nada do que decidimos em memória foi gravado.
      const winner = await transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
      if (!winner) throw new Error('Chave de idempotência em conflito, mas a transação vencedora não está visível');
      return replayOf(winner, payloadHash);
    }
    if (entry) {
      await wallets.saveBalance(wallet);
      await ledger.add(entry);
    }
    const events = integrationEventsFor({
      transaction, wallet, entry, previousStatus: WagerTransactionStatus.Pending, correlationId: command.correlationId, at: now, newId: this.newId,
    });
    for (const event of events) await outbox.add(OutboxMessage.enqueue(event));
    return { transaction, idempotentReplay: false };
  }
}

function reportOf(
  command: ProcessWagerCommand,
  origin: MessageOrigin | undefined,
  result: ProcessWagerResult | DuplicateMessageResult,
  durationSeconds: number,
): ProcessingReport {
  const context = { providerId: command.providerId, walletId: command.walletId, correlationId: command.correlationId, messageId: origin?.messageId };
  if ('duplicateMessage' in result) return { outcome: 'duplicate-message', context, durationSeconds };
  return { outcome: result.idempotentReplay ? 'replay' : 'new', transaction: result.transaction, context, durationSeconds };
}

/** Para a chave de um provedor: mesmo payload é replay; payload diferente é conflito, nunca replay. */
function replayOf(existing: WagerTransaction, payloadHash: string): ProcessWagerResult {
  if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError();
  return { transaction: existing, idempotentReplay: true };
}
