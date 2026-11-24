import { beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createQueues } from '../../scripts/create-queues';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';

// MiniStack REAL (docker compose). Filas com prefixo único por execução: não depende de estado anterior.
const prefix = `t${Date.now()}-`;
let client: SQSClient;
let q: Awaited<ReturnType<typeof createQueues>>;

const receive = async (url: string, opts: { visibility?: number; max?: number } = {}) => {
  const r = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: opts.max ?? 10,
      VisibilityTimeout: opts.visibility ?? 30,
      WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return r.Messages ?? [];
};

beforeAll(async () => {
  client = createSqsClient();
  q = await createQueues(client, prefix);
});

describe('MiniStack: SQS FIFO + DLQ', () => {
  test('criação de filas é idempotente (mesmas URLs na 2ª chamada)', async () => {
    const again = await createQueues(client, prefix);
    expect(again['wager-transactions.fifo']!.url).toBe(q['wager-transactions.fifo']!.url);
    expect(again['wager-transactions-dlq.fifo']!.url).toBe(q['wager-transactions-dlq.fifo']!.url);
    expect(again['wager-events']!.url).toBe(q['wager-events']!.url);
  });

  test('FIFO preserva a ordem dentro do MessageGroupId e expõe o grupo', async () => {
    const url = q['wager-transactions.fifo']!.url;
    for (const n of [1, 2, 3]) {
      await client.send(new SendMessageCommand({
        QueueUrl: url, MessageBody: `m${n}`, MessageGroupId: 'wallet-A', MessageDeduplicationId: `order-${n}`,
      }));
    }
    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      // FIFO entrega 1 mensagem por grupo por vez enquanto a anterior está em voo: confirma ordem
      const [m] = await receive(url, { max: 1 });
      expect(m).toBeDefined();
      expect(m!.Attributes?.MessageGroupId).toBe('wallet-A');
      got.push(m!.Body!);
      // apaga para liberar a próxima mensagem do grupo
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m!.ReceiptHandle! }));
    }
    expect(got).toEqual(['m1', 'm2', 'm3']);
  });

  test('MessageDeduplicationId repetido não duplica a mensagem', async () => {
    const url = q['wager-transactions.fifo']!.url;
    for (let i = 0; i < 3; i++) {
      await client.send(new SendMessageCommand({
        QueueUrl: url, MessageBody: 'dup', MessageGroupId: 'wallet-B', MessageDeduplicationId: 'same-id',
      }));
    }
    const msgs = await receive(url, { max: 10 });
    expect(msgs.filter((m) => m.Body === 'dup')).toHaveLength(1);
  });

  test('ChangeMessageVisibility(0) devolve a mensagem e incrementa ApproximateReceiveCount', async () => {
    const url = q['wager-transactions.fifo']!.url;
    await client.send(new SendMessageCommand({
      QueueUrl: url, MessageBody: 'vis', MessageGroupId: 'wallet-C', MessageDeduplicationId: 'vis-1',
    }));
    const [first] = await receive(url, { max: 1 });
    expect(first?.Body).toBe('vis');
    expect(first!.Attributes?.ApproximateReceiveCount).toBe('1');
    await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: first!.ReceiptHandle!, VisibilityTimeout: 0 }));
    const [second] = await receive(url, { max: 1 });
    expect(second?.Body).toBe('vis');
    expect(second!.Attributes?.ApproximateReceiveCount).toBe('2');
  });

  test('redrive: após maxReceiveCount=5 a mensagem vai para a DLQ com o mesmo MessageGroupId', async () => {
    const main = q['wager-transactions.fifo']!.url;
    const dlq = q['wager-transactions-dlq.fifo']!.url;
    await client.send(new SendMessageCommand({
      QueueUrl: main, MessageBody: 'poison', MessageGroupId: 'wallet-D', MessageDeduplicationId: 'poison-1',
    }));
    let received = 0;
    for (let i = 0; i < 8; i++) {
      const msgs = await receive(main, { visibility: 0 });
      const poison = msgs.find((m) => m.Body === 'poison');
      if (!poison) break;
      received++;
      await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: main, ReceiptHandle: poison.ReceiptHandle!, VisibilityTimeout: 0 }));
    }
    expect(received).toBe(5);
    const inDlq = (await receive(dlq)).find((m) => m.Body === 'poison');
    expect(inDlq).toBeDefined();
    expect(inDlq!.Attributes?.MessageGroupId).toBe('wallet-D');
  });

  test('fila standard wager-events aceita e entrega mensagem', async () => {
    const url = q['wager-events']!.url;
    await client.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'evt' }));
    const msgs = await receive(url);
    expect(msgs.map((m) => m.Body)).toContain('evt');
  });
});
