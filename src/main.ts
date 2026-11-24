import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { QueueConsumer } from './interface/sqs/queue-consumer';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env['PORT'] ?? '3000');
  // Todas as instâncias rodam o loop: o claim por lease (SKIP LOCKED) divide o trabalho sem coordenação.
  app.get(PendingReferenceWorker).start();
  // Idem: o inbox e o lock da wallet dividem o trabalho entre instâncias; o SQS FIFO só reduz a disputa.
  app.get(QueueConsumer).start();
}

void bootstrap();
