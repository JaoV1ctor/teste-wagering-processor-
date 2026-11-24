import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule, PENDING_REFERENCE_WORKER } from './app.module';
import type { PollingWorker } from './infrastructure/workers/polling-worker';
import { QueueConsumer } from './interface/sqs/queue-consumer';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env['PORT'] ?? '3000');
  // Todas as instâncias rodam o loop: o claim por lease (SKIP LOCKED) divide o trabalho sem coordenação.
  app.get<PollingWorker>(PENDING_REFERENCE_WORKER).start();
  // Idem: o inbox e o lock da wallet dividem o trabalho entre instâncias; o SQS FIFO só reduz a disputa.
  app.get(QueueConsumer).start();
}

void bootstrap();
