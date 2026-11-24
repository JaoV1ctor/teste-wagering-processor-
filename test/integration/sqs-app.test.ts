// A aplicação real (AppModule + DI + variáveis de ambiente): o consumidor sobe pelo módulo, processa pela fila real e encerra limpo.
import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { QueueConsumer } from '../../src/interface/sqs/queue-consumer';
import { startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { isQueueEmpty, newQueues, sendWager, type TestQueues, waitFor } from '../support/sqs';
import { openWallet } from '../support/wager';

const probe = createProbe(2);
const ENV_KEYS = ['SQS_WAGER_QUEUE_NAME', 'SQS_WAGER_DLQ_NAME', 'SHUTDOWN_TIMEOUT_MS', 'SQS_WAIT_TIME_SECONDS'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let client: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  await ensureSchema();
  client = createSqsClient();
  queues = await newQueues(client);
  process.env['SQS_WAGER_QUEUE_NAME'] = queues.names.queueName;
  process.env['SQS_WAGER_DLQ_NAME'] = queues.names.deadLetterQueueName;
  process.env['SHUTDOWN_TIMEOUT_MS'] = '2000';
  process.env['SQS_WAIT_TIME_SECONDS'] = '1';
});
afterAll(async () => {
  await probe.end();
  client.destroy();
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('o AppModule monta o consumidor com a config do ambiente: processa pela fila e o HTTP continua respondendo', async () => {
  const api = await startApi();
  try {
    const wallet = await openWallet(api, '100.00');
    api.app.get(QueueConsumer).start();

    await sendWager(client, queues, { id: wallet.walletId, playerId: wallet.playerId }, { amount: '30.00' });
    await waitFor('fila vazia (ack feito)', () => isQueueEmpty(client, queues.mainUrl));

    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    const read = await api.call('GET', `/wallets/${wallet.walletId}`);
    expect(read.status).toBe(200);
    expect(read.body.balance.amount).toBe('70.00');
  } finally {
    await api.close();
  }
});

test('app.close() (o caminho do SIGTERM) para o consumidor: o que chega depois fica na fila, sem processamento', async () => {
  const api = await startApi();
  const wallet = await openWallet(api, '100.00');
  const consumer = api.app.get(QueueConsumer);
  consumer.start();

  await api.close(); // beforeApplicationShutdown -> consumer.stop() -> ORM fecha
  await sendWager(client, queues, { id: wallet.walletId, playerId: wallet.playerId });
  await Bun.sleep(1500); // janela para PROVAR que nada é consumido depois do encerramento

  // Continua na fila (visível ou em voo): um long polling abortado no cliente ainda pode estar vivo no servidor e "engolir" a mensagem
  // até a visibilidade vencer. O que o teste prova é que NINGUÉM a processou nem a apagou.
  expect(await isQueueEmpty(client, queues.mainUrl)).toBe(false);
  expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
});
