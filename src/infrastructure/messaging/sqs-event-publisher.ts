import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Publica os eventos na fila PADRÃO `wager-events` (SPEC D8). Fila padrão: sem `MessageGroupId`, sem deduplicação do SQS e sem garantia
 * de ordem; o consumidor deduplica pelo `eventId` (atributo da mensagem e campo do envelope) e ordena por `walletVersion`.
 * Como `SqsMessageQueue`, a URL é resolvida por nome na primeira chamada e a falha não fica guardada.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageAttributes: {
          eventId: { DataType: 'String', StringValue: message.id },
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.client
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error('GetQueueUrl sem QueueUrl');
        return QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined; // não guarda a falha: a próxima chamada tenta de novo
        throw error;
      });
    return this.queueUrl;
  }
}
