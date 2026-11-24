import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand, type Message, type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MessageQueue, QueueMessage, ReceiveOptions } from './message-queue';

export interface SqsQueueNames {
  queueName: string;
  deadLetterQueueName: string;
}

/**
 * Adaptador SQS da fila FIFO de entrada e da DLQ. As URLs são resolvidas por nome na primeira chamada (não no boot): a aplicação sobe
 * e atende HTTP mesmo com o SQS fora, e o consumidor tenta de novo a cada ciclo.
 */
export class SqsMessageQueue implements MessageQueue {
  private urls: Promise<{ queue: string; deadLetter: string }> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly names: SqsQueueNames,
  ) {}

  async receive({ maxMessages, waitTimeSeconds, visibilityTimeoutSeconds, signal }: ReceiveOptions): Promise<QueueMessage[]> {
    const { queue } = await this.resolveUrls();
    const received = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queue,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    return (received.Messages ?? []).map(toQueueMessage);
  }

  async acknowledge(message: QueueMessage): Promise<void> {
    const { queue } = await this.resolveUrls();
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.receiptHandle }));
  }

  async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    const { queue } = await this.resolveUrls();
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queue, ReceiptHandle: message.receiptHandle, VisibilityTimeout: seconds }));
  }

  /**
   * O `MessageDeduplicationId` é o MessageId do SQS da mensagem original: se o worker morrer depois de enviar e antes do ack,
   * a reentrega gera o mesmo id e o SQS descarta a cópia (janela de 5 min), então a DLQ não duplica.
   */
  async deadLetter(message: QueueMessage, reason: string): Promise<void> {
    const { deadLetter } = await this.resolveUrls();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: deadLetter,
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { FailureReason: { DataType: 'String', StringValue: reason } },
      }),
    );
  }

  private resolveUrls(): Promise<{ queue: string; deadLetter: string }> {
    this.urls ??= Promise.all([
      this.client.send(new GetQueueUrlCommand({ QueueName: this.names.queueName })),
      this.client.send(new GetQueueUrlCommand({ QueueName: this.names.deadLetterQueueName })),
    ])
      .then(([queue, deadLetter]) => {
        if (!queue.QueueUrl || !deadLetter.QueueUrl) throw new Error('GetQueueUrl sem QueueUrl');
        return { queue: queue.QueueUrl, deadLetter: deadLetter.QueueUrl };
      })
      .catch((error: unknown) => {
        this.urls = undefined; // não guarda a falha: a próxima chamada tenta de novo
        throw error;
      });
    return this.urls;
  }
}

function toQueueMessage(message: Message): QueueMessage {
  const { MessageId: id, ReceiptHandle: receiptHandle, Body: body } = message;
  if (!id || !receiptHandle || body === undefined) throw new Error('Mensagem do SQS sem MessageId, ReceiptHandle ou Body');
  return {
    id,
    receiptHandle,
    body,
    // Fila FIFO sempre tem grupo; o MessageId é só uma chave de serialização segura caso a fila seja padrão.
    groupId: message.Attributes?.['MessageGroupId'] ?? id,
    receiveCount: Number.parseInt(message.Attributes?.['ApproximateReceiveCount'] ?? '1', 10),
  };
}
