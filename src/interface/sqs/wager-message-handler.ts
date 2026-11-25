import {
  IdempotencyConflictError, InboxPayloadConflictError, TransientInfrastructureError, WalletNotFoundError,
} from '../../application/errors';
import type { DuplicateMessageResult, MessageOrigin, ProcessWagerCommand, ProcessWagerResult } from '../../application/process-wager-transaction.use-case';
import { describeError, type logJson } from '../../infrastructure/observability/json-log';
import { type VisibilityBackoffOptions, visibilityBackoffSeconds } from './visibility-backoff';
import { MalformedMessageError, parseWagerMessage, UnknownMessageTypeError } from './wager-transaction-message';

/** Nome lógico deste consumidor no inbox: todas as instâncias compartilham, por isso a deduplicação vale entre processos. */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

/** O que o consumidor precisa do caso de uso; `ProcessWagerTransactionUseCase` satisfaz. */
export interface WagerProcessor {
  execute(command: ProcessWagerCommand, origin: MessageOrigin): Promise<ProcessWagerResult | DuplicateMessageResult>;
}

/** Códigos legíveis por máquina que acompanham a mensagem na DLQ (atributo `FailureReason`). */
export type DeadLetterReason =
  | 'MALFORMED_MESSAGE'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INBOX_PAYLOAD_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'UNEXPECTED_ERROR';

/** Decisão sobre a mensagem. Quem a executa (confirmar, adiar, enviar à DLQ) é o consumidor, que conhece a fila. */
export type Disposition =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number }
  | { action: 'dead-letter'; reason: DeadLetterReason };

export interface WagerMessageHandlerOptions {
  consumerName: string;
  backoff: VisibilityBackoffOptions;
  random?: () => number;
  log: typeof logJson;
}

/**
 * Traduz uma mensagem do SQS em uma chamada ao caso de uso e classifica o resultado. Sem regra de negócio.
 *  - NEGÓCIO (PROCESSED, REJECTED, PENDING_REFERENCE, replay, duplicata do inbox): o commit já gravou o resultado => ack.
 *  - TRANSITÓRIO (`TransientInfrastructureError`: Postgres fora, 40P01, 40001, 55P03, retry esgotado) => sem ack, backoff.
 *  - PERMANENTE (malformada, tipo desconhecido, conflito, wallet inexistente, bug) => DLQ explícita e depois ack.
 * O log usa o `messageId` como correlationId e nunca o corpo. O sucesso é logado por quem observa o caso de uso (`ObservedProcessing`), com os ids da transação.
 */
export class WagerMessageHandler {
  constructor(
    private readonly processor: WagerProcessor,
    private readonly options: WagerMessageHandlerOptions,
  ) {}

  async handle(body: string, receiveCount: number): Promise<Disposition> {
    let messageId: string | undefined;
    try {
      const parsed = parseWagerMessage(body);
      messageId = parsed.messageId;
      await this.processor.execute({ ...parsed.command, correlationId: messageId }, { consumerName: this.options.consumerName, messageId });
      return { action: 'ack' };
    } catch (error) {
      return this.classify(error, messageId, receiveCount);
    }
  }

  private classify(error: unknown, messageId: string | undefined, receiveCount: number): Disposition {
    const fields = { correlationId: messageId, messageId, receiveCount, ...describeError(error) };
    if (error instanceof TransientInfrastructureError) {
      const delaySeconds = visibilityBackoffSeconds(receiveCount, this.options.backoff, this.options.random ?? Math.random);
      this.options.log('error', 'wager_message_transient_failure', { ...fields, delaySeconds });
      return { action: 'retry', delaySeconds };
    }
    const reason = deadLetterReasonFor(error);
    this.options.log('error', 'wager_message_permanent_failure', { ...fields, reason });
    return { action: 'dead-letter', reason };
  }
}

function deadLetterReasonFor(error: unknown): DeadLetterReason {
  if (error instanceof UnknownMessageTypeError) return 'UNKNOWN_MESSAGE_TYPE';
  if (error instanceof MalformedMessageError) return 'MALFORMED_MESSAGE';
  if (error instanceof IdempotencyConflictError) return 'IDEMPOTENCY_CONFLICT';
  if (error instanceof InboxPayloadConflictError) return 'INBOX_PAYLOAD_CONFLICT';
  if (error instanceof WalletNotFoundError) return 'WALLET_NOT_FOUND';
  return 'UNEXPECTED_ERROR';
}
