import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

/** Cria as filas do desafio. Idempotente: CreateQueue com os mesmos atributos devolve a fila existente. */
export async function createQueues(
  client: SQSClient,
  prefix = '',
  abortSignal?: AbortSignal,
): Promise<Record<string, { url: string; arn: string }>> {
  const options = abortSignal ? { abortSignal } : {};
  const create = async (name: string, attributes: Record<string, string>) => {
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: `${prefix}${name}`, Attributes: attributes }), options);
    if (!QueueUrl) throw new Error(`CreateQueue sem QueueUrl: ${name}`);
    const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), options);
    const arn = attrs.Attributes?.QueueArn;
    if (!arn) throw new Error(`Fila sem ARN: ${name}`);
    return { url: QueueUrl, arn };
  };

  const dlq = await create('wager-transactions-dlq.fifo', {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    MessageRetentionPeriod: '1209600',
  });
  const main = await create('wager-transactions.fifo', {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }),
  });
  const events = await create('wager-events', { VisibilityTimeout: '30' });
  return { 'wager-transactions.fifo': main, 'wager-transactions-dlq.fifo': dlq, 'wager-events': events };
}

export class QueueServiceUnavailableError extends Error {}

/** `ECONNRESET`: com o container ainda sem escutar, a porta publicada pelo Docker pode aceitar a conexão e encerrá-la. */
const UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);
/** `AbortError`: a tentativa estourou o próprio prazo. `TimeoutError`: o nome que o SDK dá à falta de resposta. */
const UNAVAILABLE_NAMES = new Set(['AbortError', 'TimeoutError', 'ServiceUnavailable']);

const codeOf = (error: Error): string | undefined => (error as Error & { code?: string }).code;

function isUnavailable(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = codeOf(error);
  const { $metadata } = error as Error & { $metadata?: { httpStatusCode?: number } };
  return UNAVAILABLE_NAMES.has(error.name) || (code !== undefined && UNAVAILABLE_CODES.has(code)) || $metadata?.httpStatusCode === 503;
}

const READY_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 500;
/** Teto de uma tentativa, para uma conexão que não responde não consumir o prazo inteiro. */
const ATTEMPT_TIMEOUT_MS = 5_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<unknown>;
}

/**
 * `createQueues` esperando o serviço subir: repete enquanto o erro for de indisponibilidade, por até 30 s. Qualquer outro erro sobe na
 * hora. Repetir é seguro porque a criação é idempotente.
 */
export async function createQueuesWhenReady(client: SQSClient, clock: Clock = { now: Date.now, sleep: Bun.sleep }) {
  const deadline = clock.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      return await createQueues(client, '', AbortSignal.timeout(Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadline - clock.now()))));
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      if (clock.now() + RETRY_INTERVAL_MS >= deadline) {
        throw new QueueServiceUnavailableError(
          `O MiniStack não respondeu em ${READY_TIMEOUT_MS / 1000} s (último erro: ${error.message || codeOf(error) || error.name}). ` +
            'Confira se o container está no ar (docker compose up -d --wait) e se AWS_ENDPOINT_URL aponta para ele.',
          { cause: error },
        );
      }
      await clock.sleep(RETRY_INTERVAL_MS);
    }
  }
}

if (import.meta.main) {
  try {
    const queues = await createQueuesWhenReady(createSqsClient());
    for (const [name, q] of Object.entries(queues)) process.stdout.write(`${name} ${q.url}\n`);
  } catch (error) {
    if (!(error instanceof QueueServiceUnavailableError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
