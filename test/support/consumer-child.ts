// Processo FILHO: um consumidor SQS completo (próprio pool no Postgres), que o teste pode matar com SIGKILL no meio de uma transação.
// Filas por SQS_WAGER_QUEUE_NAME / SQS_WAGER_DLQ_NAME. Imprime `READY` quando começa a consumir.
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../../src/infrastructure/env';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createTestConsumer, RecordingProcessor } from './sqs';

const orm = await MikroORM.init(createOrmConfig());
const queue = new SqsMessageQueue(createSqsClient(), {
  queueName: requireEnv('SQS_WAGER_QUEUE_NAME'), deadLetterQueueName: requireEnv('SQS_WAGER_DLQ_NAME'),
});
// lock_timeout longo: o filho espera o lock da wallet (segurado pelo teste) em vez de desistir com 55P03.
const processor = new RecordingProcessor(new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 120_000 }));
const { consumer } = createTestConsumer({ queue, processor, consume: { visibilityTimeoutSeconds: 2 } });
consumer.start();
process.stdout.write('READY\n');
