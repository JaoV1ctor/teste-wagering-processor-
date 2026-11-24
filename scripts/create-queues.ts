import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { requireEnv } from '../src/infrastructure/env';

/** Cria as filas do desafio. Idempotente: CreateQueue com os mesmos atributos devolve a fila existente. */
export async function createQueues(client: SQSClient, prefix = ''): Promise<Record<string, { url: string; arn: string }>> {
  const create = async (name: string, attributes: Record<string, string>) => {
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: `${prefix}${name}`, Attributes: attributes }));
    if (!QueueUrl) throw new Error(`CreateQueue sem QueueUrl: ${name}`);
    const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
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

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: requireEnv('AWS_ENDPOINT_URL'),
    region: requireEnv('AWS_REGION'),
    credentials: { accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'), secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY') },
  });
}

if (import.meta.main) {
  const queues = await createQueues(createSqsClient());
  for (const [name, q] of Object.entries(queues)) console.log(name, q.url);
}
