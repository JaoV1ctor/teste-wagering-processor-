// O CLI produtor da demonstração, de ponta a ponta: processo real -> MiniStack -> consumidor -> Postgres.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { Money } from '../../src/domain/money';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { createTestConsumer, isQueueEmpty, newQueues, peek, RecordingProcessor, waitFor } from '../support/sqs';

const probe = createProbe(2);
let orm: MikroORM;
let client: SQSClient;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  client = createSqsClient();
});
afterAll(async () => {
  await probe.end();
  await orm.close();
  client.destroy();
});

test('send-wager-message: MessageGroupId = walletId, MessageDeduplicationId = messageId, e o consumidor processa', async () => {
  const uow = new MikroOrmUnitOfWork(orm);
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: Money.fromString('100.00', 'BRL') });
  const queues = await newQueues(client);
  const messageId = `cli-${uuid()}`;

  const cli = Bun.spawn(
    [
      'bun', 'run', 'scripts/send-wager-message.ts', '--wallet-id', wallet.id, '--player-id', wallet.playerId, '--provider-id', 'provider-a',
      '--round-id', 'round-1', '--game-id', 'game-1', '--kind', 'BET', '--amount', '40.00', '--currency', 'BRL', '--message-id', messageId,
    ],
    { env: { ...process.env, SQS_WAGER_QUEUE_NAME: queues.names.queueName }, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await cli.exited).toBe(0);
  const { messageId: printed } = JSON.parse(await new Response(cli.stdout).text());
  expect(printed).toBe(messageId);

  const [sent] = await peek(client, queues.mainUrl);
  expect(sent?.Attributes?.['MessageGroupId']).toBe(wallet.id);
  expect(sent?.Attributes?.['MessageDeduplicationId']).toBe(messageId);

  const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor: new RecordingProcessor(uow) });
  consumer.start();
  try {
    await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));
  } finally {
    await consumer.stop();
  }
  expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '60.00', rebuilt: '60.00', entries: 2 });
});

test('send-wager-message: argumento obrigatório ausente falha com código != 0 e não envia nada', async () => {
  const queues = await newQueues(client);
  const cli = Bun.spawn(['bun', 'run', 'scripts/send-wager-message.ts', '--kind', 'BET'], {
    env: { ...process.env, SQS_WAGER_QUEUE_NAME: queues.names.queueName }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(await cli.exited).not.toBe(0);
  expect(await isQueueEmpty(client, queues.mainUrl)).toBe(true);
});
