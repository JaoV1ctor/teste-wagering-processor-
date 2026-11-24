import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';
import { requireEnv } from '../src/infrastructure/env';
import { WAGER_TRANSACTION_REQUESTED, type WagerTransactionRequested } from '../src/interface/sqs/wager-transaction-message';

export interface WagerMessageInput {
  /** Gerados quando omitidos. */
  messageId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Decimal em string, p. ex. "25.00". */
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

/** Monta a mensagem do README §10. A chave de idempotência padrão é `{providerId}:{externalTransactionId}` (README §9). */
export function buildWagerMessage(input: WagerMessageInput, now: Date = new Date()): WagerTransactionRequested {
  const externalTransactionId = input.externalTransactionId ?? `ext-${randomUUID()}`;
  return {
    messageId: input.messageId ?? randomUUID(),
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt: now.toISOString(),
    data: {
      providerId: input.providerId,
      externalTransactionId,
      idempotencyKey: input.idempotencyKey ?? `${input.providerId}:${externalTransactionId}`,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: { amount: input.amount, currency: input.currency },
      ...(input.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
    },
  };
}

/** `MessageGroupId = walletId` (ordem por wallet) e `MessageDeduplicationId = messageId`. Otimização: a garantia continua no banco. */
export async function sendWagerMessage(client: SQSClient, queueUrl: string, message: WagerTransactionRequested): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId,
      MessageDeduplicationId: message.messageId,
    }),
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'wallet-id': { type: 'string' }, 'player-id': { type: 'string' }, 'provider-id': { type: 'string' }, 'round-id': { type: 'string' },
      'game-id': { type: 'string' }, kind: { type: 'string' }, amount: { type: 'string' }, currency: { type: 'string' },
      'message-id': { type: 'string' }, 'external-transaction-id': { type: 'string' }, 'idempotency-key': { type: 'string' },
      reference: { type: 'string' },
    },
  });
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (!value) throw new Error(`Argumento obrigatório ausente: --${name}`);
    return value;
  };
  const message = buildWagerMessage({
    walletId: required('wallet-id'), playerId: required('player-id'), providerId: required('provider-id'), roundId: required('round-id'),
    gameId: required('game-id'), kind: required('kind'), amount: required('amount'), currency: required('currency'),
    ...(values['message-id'] === undefined ? {} : { messageId: values['message-id'] }),
    ...(values['external-transaction-id'] === undefined ? {} : { externalTransactionId: values['external-transaction-id'] }),
    ...(values['idempotency-key'] === undefined ? {} : { idempotencyKey: values['idempotency-key'] }),
    ...(values.reference === undefined ? {} : { referenceExternalTransactionId: values.reference }),
  });
  const client = createSqsClient();
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: requireEnv('SQS_WAGER_QUEUE_NAME') }));
  if (!QueueUrl) throw new Error('GetQueueUrl sem QueueUrl');
  await sendWagerMessage(client, QueueUrl, message);
  client.destroy();
  process.stdout.write(`${JSON.stringify({ messageId: message.messageId, externalTransactionId: message.data.externalTransactionId })}\n`);
}
