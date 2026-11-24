// Métricas do caminho SQS (DLQ, retries, duplicatas) com Postgres e MiniStack REAIS: o consumidor, a fila e o caso de uso são os de produção;
// só se acrescenta o que observa (Metrics) e, para forçar uma falha transitória, um gancho ANTES do caso de uso real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { TransientInfrastructureError } from '../../src/application/errors';
import { Money } from '../../src/domain/money';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { ObservedProcessing } from '../../src/infrastructure/observability/observed-processing';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { parseMetrics, total } from '../support/metrics';
import { createTestConsumer, isQueueEmpty, newQueues, peek, RecordingProcessor, sendRaw, sendWager, waitFor } from '../support/sqs';

const probe = createProbe(6);
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

const silent = (): void => undefined;
const read = async (metrics: Metrics) => parseMetrics(await metrics.registry.metrics());
const count = async (metrics: Metrics, name: string, labels: Record<string, string> = {}) =>
  total({ text: '', samples: await read(metrics) }, name, labels);

/** Consumidor de produção sobre filas novas; `Metrics` e observers são os mesmos que o AppModule liga. */
async function run<T>(
  body: (ctx: { metrics: Metrics; queues: Awaited<ReturnType<typeof newQueues>>; wallet: { id: string; playerId: string }; processor: RecordingProcessor }) => Promise<T>,
  beforeExecute?: ConstructorParameters<typeof RecordingProcessor>[1],
): Promise<T> {
  const metrics = new Metrics();
  const uow = new MikroOrmUnitOfWork(orm, { observer: metrics });
  const created = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: Money.fromString('100.00', 'BRL') });
  const queues = await newQueues(client);
  const processor = new RecordingProcessor(uow, beforeExecute, new ObservedProcessing(metrics, silent));
  const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor, observer: metrics });
  consumer.start();
  try {
    return await body({ metrics, queues, wallet: { id: created.id, playerId: created.playerId }, processor });
  } finally {
    await consumer.stop();
  }
}

describe('wager_dlq_messages_total', () => {
  test('mensagem malformada vai à DLQ por decisão do consumidor: conta 1; a mensagem boa não conta', async () => {
    await run(async ({ metrics, queues, wallet }) => {
      await sendWager(client, queues, wallet, { amount: '10.00' });
      await sendRaw(client, queues.mainUrl, '{isto não é json');

      await waitFor('as duas mensagens confirmadas', () => isQueueEmpty(client, queues.mainUrl));
      expect(await peek(client, queues.dlqUrl)).toHaveLength(1);

      expect(await count(metrics, 'wager_dlq_messages_total')).toBe(1);
      expect(await count(metrics, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
      expect(await ledgerBalance(probe, wallet.id)).toMatchObject({ stored: '90.00', rebuilt: '90.00' });
    });
  });
});

describe('wager_retries_total{source="queue"}', () => {
  test('falha transitória: a mensagem volta à fila (não é confirmada) e conta 1 retry; a reentrega processa uma vez só', async () => {
    let attempts = 0;
    await run(async ({ metrics, queues, wallet, processor }) => {
      await sendWager(client, queues, wallet, { amount: '10.00' });

      await waitFor('processada na reentrega', () => processor.outcomes.length === 1);
      await waitFor('fila vazia (ack da reentrega)', () => isQueueEmpty(client, queues.mainUrl));

      expect(attempts).toBe(2);
      expect(await count(metrics, 'wager_retries_total', { source: 'queue' })).toBe(1);
      expect(await count(metrics, 'wager_retries_total', { source: 'database' })).toBe(0);
      expect(await count(metrics, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
      expect(await count(metrics, 'wager_dlq_messages_total')).toBe(0);
      expect(await ledgerBalance(probe, wallet.id)).toMatchObject({ stored: '90.00', rebuilt: '90.00' });
    }, async () => {
      attempts += 1;
      if (attempts === 1) throw new TransientInfrastructureError(new Error('falha injetada antes do caso de uso'));
    });
  });
});

describe('wager_duplicates_total', () => {
  test('a mesma mensagem entregue duas vezes: 1 transação nova, 1 duplicata, 1 débito', async () => {
    await run(async ({ metrics, queues, wallet, processor }) => {
      const message = await sendWager(client, queues, wallet, { amount: '25.00' });
      await sendRaw(client, queues.mainUrl, JSON.stringify(message), { groupId: wallet.id });

      await waitFor('as duas entregas processadas', () => processor.outcomes.length === 2);
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));

      expect(await count(metrics, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
      expect(await count(metrics, 'wager_duplicates_total')).toBe(1);
      expect(await ledgerBalance(probe, wallet.id)).toMatchObject({ stored: '75.00', rebuilt: '75.00' });
    });
  });
});
