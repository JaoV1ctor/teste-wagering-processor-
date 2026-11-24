// Ordem do encerramento (README §10, SPEC §8.1): consumidor e worker param ANTES de o ORM fechar. Unidade: fakes só registram a ordem das chamadas.
import 'reflect-metadata';
import { expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import type { PollingWorker } from '../../src/infrastructure/workers/polling-worker';
import type { QueueConsumer } from '../../src/interface/sqs/queue-consumer';

test('stop do consumidor e do worker termina antes de orm.close(); o cliente SQS fecha por último', async () => {
  const events: string[] = [];
  const slow = (name: string, ms: number) => async () => {
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    events.push(`${name}:end`);
  };
  const module = new AppModule(
    { close: async () => void events.push('orm:close') } as unknown as MikroORM,
    { stop: slow('worker', 20) } as unknown as PollingWorker,
    { stop: slow('consumer', 50) } as unknown as QueueConsumer,
    { destroy: () => void events.push('sqs:destroy') } as unknown as SQSClient,
  );

  // Ordem do ciclo de vida do Nest: beforeApplicationShutdown -> (HTTP fecha) -> onApplicationShutdown.
  await module.beforeApplicationShutdown();
  await module.onApplicationShutdown();

  expect(events.indexOf('orm:close')).toBeGreaterThan(events.indexOf('consumer:end'));
  expect(events.indexOf('orm:close')).toBeGreaterThan(events.indexOf('worker:end'));
  expect(events.slice(0, 2).sort()).toEqual(['consumer:start', 'worker:start']); // param em paralelo: o mais lento não atrasa o outro
  expect(events.at(-1)).toBe('sqs:destroy');
});
