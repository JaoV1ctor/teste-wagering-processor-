import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env['PORT'] ?? '3000');
  // Todas as instâncias rodam o loop: o claim por lease (SKIP LOCKED) divide o trabalho sem coordenação.
  app.get(PendingReferenceWorker).start();
}

void bootstrap();
