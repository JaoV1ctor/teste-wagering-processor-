import { randomUUID as uuid } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, type Message, type SQSClient,
} from '@aws-sdk/client-sqs';
import { createQueues } from '../../scripts/create-queues';
import { buildWagerMessage, sendWagerMessage, type WagerMessageInput } from '../../scripts/send-wager-message';
import type { UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { type MessageQueue, type QueueMessage } from '../../src/infrastructure/messaging/message-queue';
import { type VisibilityBackoffOptions } from '../../src/interface/sqs/visibility-backoff';
import { WAGER_CONSUMER_NAME, WagerMessageHandler, type WagerProcessor } from '../../src/interface/sqs/wager-message-handler';
import { QueueConsumer, type QueueConsumerOptions } from '../../src/interface/sqs/queue-consumer';
import type { WagerTransactionRequested } from '../../src/interface/sqs/wager-transaction-message';

/** Filas FIFO + DLQ reais no MiniStack, com prefixo único: cada teste vê só as próprias mensagens. */
export interface TestQueues {
  names: { queueName: string; deadLetterQueueName: string };
  mainUrl: string;
  dlqUrl: string;
  /** Fila padrão de eventos de integração (destino do outbox). */
  eventsQueueName: string;
  eventsUrl: string;
}

export async function newQueues(client: SQSClient): Promise<TestQueues> {
  const prefix = `t${Date.now()}-${uuid().slice(0, 8)}-`;
  const created = await createQueues(client, prefix);
  return {
    names: { queueName: `${prefix}wager-transactions.fifo`, deadLetterQueueName: `${prefix}wager-transactions-dlq.fifo` },
    mainUrl: created['wager-transactions.fifo']!.url,
    dlqUrl: created['wager-transactions-dlq.fifo']!.url,
    eventsQueueName: `${prefix}wager-events`,
    eventsUrl: created['wager-events']!.url,
  };
}

export interface TestWallet {
  id: string;
  playerId: string;
}

/** Envia uma mensagem de aposta pelo MESMO produtor usado na demonstração (MessageGroupId = walletId, MessageDeduplicationId = messageId). */
export async function sendWager(
  client: SQSClient,
  queues: TestQueues,
  wallet: TestWallet,
  input: Partial<WagerMessageInput> = {},
): Promise<WagerTransactionRequested> {
  const message = buildWagerMessage({
    providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind: 'BET', amount: '25.00',
    currency: 'BRL', ...input,
  });
  await sendWagerMessage(client, queues.mainUrl, message);
  return message;
}

/** Corpo arbitrário (mensagens que o produtor oficial nunca geraria). */
export async function sendRaw(
  client: SQSClient,
  queueUrl: string,
  body: string,
  { groupId = uuid(), deduplicationId = uuid() }: { groupId?: string; deduplicationId?: string } = {},
): Promise<void> {
  await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }));
}

/** Lê direto da fila (fora do consumidor). `visibility: 0` deixa a mensagem visível de novo, sem afetar o `ApproximateReceiveCount` da DLQ. */
export async function peek(client: SQSClient, queueUrl: string, { visibility = 0, max = 10 } = {}): Promise<Message[]> {
  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: max, VisibilityTimeout: visibility, WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['All'], MessageAttributeNames: ['All'],
    }),
  );
  return received.Messages ?? [];
}

export async function queueDepth(client: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
  );
  return {
    visible: Number.parseInt(Attributes?.['ApproximateNumberOfMessages'] ?? '0', 10),
    inFlight: Number.parseInt(Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '0', 10),
  };
}

export async function isQueueEmpty(client: SQSClient, queueUrl: string): Promise<boolean> {
  const { visible, inFlight } = await queueDepth(client, queueUrl);
  return visible === 0 && inFlight === 0;
}

/**
 * Espera uma condição ASSÍNCRONA do sistema (o consumidor roda em segundo plano). Consulta até o prazo; estourar é falha do teste,
 * nunca um sleep fixo para "dar tempo".
 */
export async function waitFor(description: string, condition: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Tempo esgotado esperando: ${description}`);
    await sleep(50);
  }
}

/** Fila real decorada: cada operação pode ser observada ou interceptada pelo teste (quem decide quando "o worker morre"). */
export interface QueueInterceptors {
  onReceive?: (next: () => Promise<QueueMessage[]>) => Promise<QueueMessage[]>;
  onAcknowledge?: (message: QueueMessage, next: () => Promise<void>) => Promise<void>;
  onChangeVisibility?: (message: QueueMessage, seconds: number, next: () => Promise<void>) => Promise<void>;
  onDeadLetter?: (message: QueueMessage, reason: string, next: () => Promise<void>) => Promise<void>;
}

export class InterceptingQueue implements MessageQueue {
  constructor(
    private readonly inner: MessageQueue,
    private readonly interceptors: QueueInterceptors = {},
  ) {}

  receive(options: Parameters<MessageQueue['receive']>[0]): Promise<QueueMessage[]> {
    const next = () => this.inner.receive(options);
    return this.interceptors.onReceive ? this.interceptors.onReceive(next) : next();
  }

  acknowledge(message: QueueMessage): Promise<void> {
    const next = () => this.inner.acknowledge(message);
    return this.interceptors.onAcknowledge ? this.interceptors.onAcknowledge(message, next) : next();
  }

  changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    const next = () => this.inner.changeVisibility(message, seconds);
    return this.interceptors.onChangeVisibility ? this.interceptors.onChangeVisibility(message, seconds, next) : next();
  }

  deadLetter(message: QueueMessage, reason: string): Promise<void> {
    const next = () => this.inner.deadLetter(message, reason);
    return this.interceptors.onDeadLetter ? this.interceptors.onDeadLetter(message, reason, next) : next();
  }
}

export type Outcome = Awaited<ReturnType<WagerProcessor['execute']>> | Error;

/** Caso de uso REAL (Postgres real) com observação: guarda cada resultado ou erro e permite intercalar um gancho ANTES de executar. */
export class RecordingProcessor implements WagerProcessor {
  readonly outcomes: Outcome[] = [];
  started = 0;
  private readonly real: ProcessWagerTransactionUseCase;

  constructor(
    uow: UnitOfWork,
    private readonly beforeExecute: (command: Parameters<WagerProcessor['execute']>[0]) => Promise<void> = async () => undefined,
  ) {
    this.real = new ProcessWagerTransactionUseCase(uow);
  }

  async execute(command: Parameters<WagerProcessor['execute']>[0], origin: Parameters<WagerProcessor['execute']>[1]) {
    this.started += 1;
    await this.beforeExecute(command);
    try {
      const outcome = await this.real.execute(command, origin);
      this.outcomes.push(outcome);
      return outcome;
    } catch (error) {
      this.outcomes.push(error as Error);
      throw error;
    }
  }
}

export interface TestConsumerOptions {
  queue: MessageQueue;
  processor: WagerProcessor;
  consume?: Partial<QueueConsumerOptions>;
  backoff?: VisibilityBackoffOptions;
  random?: () => number;
}

/** Monta o consumidor como a aplicação monta, com tempos curtos para os testes. Os logs ficam em memória. */
export function createTestConsumer({ queue, processor, consume = {}, backoff = { baseSeconds: 0, maxSeconds: 0 }, random }: TestConsumerOptions) {
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const log = (level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}) => {
    logs.push({ level, message, fields });
  };
  const handler = new WagerMessageHandler(processor, { consumerName: WAGER_CONSUMER_NAME, backoff, log, ...(random ? { random } : {}) });
  const consumer = new QueueConsumer(queue, handler, {
    concurrency: 5, batchSize: 10, waitTimeSeconds: 1, visibilityTimeoutSeconds: 30, shutdownTimeoutMs: 2000, receiveErrorPauseMs: 100, log,
    ...consume,
  });
  return { consumer, logs };
}
