import { z } from 'zod';
import type { ProcessWagerCommand } from '../../application/process-wager-transaction.use-case';
import type { MoneyProps } from '../../domain/money';
import { checkReferenceRules, wagerFields } from '../http/wagering.dto';

/** Único `type` de mensagem aceito na fila de entrada. */
export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/** Forma da mensagem na fila, do lado de quem produz: dinheiro sempre como string decimal. */
export interface WagerTransactionRequested {
  messageId: string;
  type: typeof WAGER_TRANSACTION_REQUESTED;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

/** Corpo que nunca poderá ser processado, por mais que seja reentregue. Erro PERMANENTE (DLQ). */
export class MalformedMessageError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

export class UnknownMessageTypeError extends MalformedMessageError {
  constructor(readonly type: string) {
    super(`Tipo de mensagem desconhecido: ${type}`);
  }
}

/** Limite de 128 porque o `messageId` é o `MessageDeduplicationId` do produtor (máximo da AWS). */
const Envelope = z.strictObject({
  messageId: z.string().min(1).max(128),
  type: z.string().min(1),
  /** Validado (faz parte do contrato da mensagem), mas não é usado: a ordem vem do SQS FIFO e do banco, não do relógio do produtor. */
  occurredAt: z.iso.datetime(),
  data: z.unknown(),
});

/** Mesmos campos e regras do POST /wagering/transactions, mais a chave de idempotência no corpo (não há header no SQS). */
const WagerTransactionData = z
  .strictObject({ ...wagerFields, idempotencyKey: z.string().min(1).max(255) })
  .check(checkReferenceRules);

export interface ParsedWagerMessage {
  messageId: string;
  command: ProcessWagerCommand;
}

/**
 * Valida o corpo na borda. A mensagem de erro cita só caminhos e códigos do zod, nunca valores: o payload não vai para log nem para exceção.
 */
export function parseWagerMessage(body: string): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MalformedMessageError('Corpo da mensagem não é JSON');
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) throw new MalformedMessageError(`Envelope inválido: ${describeIssues(envelope.error)}`);
  if (envelope.data.type !== WAGER_TRANSACTION_REQUESTED) throw new UnknownMessageTypeError(envelope.data.type);

  const data = WagerTransactionData.safeParse(envelope.data.data);
  if (!data.success) throw new MalformedMessageError(`Campo data inválido: ${describeIssues(data.error)}`);
  const { referenceExternalTransactionId, ...rest } = data.data;
  return {
    messageId: envelope.data.messageId,
    command: { ...rest, ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }) },
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'} (${issue.code})`).join(', ');
}
