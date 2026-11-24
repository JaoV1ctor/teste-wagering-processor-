import { afterEach, describe, expect, test } from 'bun:test';
import { CONSUMER_DEFAULTS, loadWagerConsumerConfig } from '../../src/infrastructure/messaging/consumer-config';

const KEYS = [
  'SQS_WAGER_QUEUE_NAME', 'SQS_WAGER_DLQ_NAME', 'SQS_CONSUMER_CONCURRENCY', 'SQS_BATCH_SIZE', 'SQS_WAIT_TIME_SECONDS',
  'SQS_VISIBILITY_TIMEOUT_SECONDS', 'SQS_RETRY_BASE_SECONDS', 'SQS_RETRY_MAX_SECONDS', 'SHUTDOWN_TIMEOUT_MS',
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const names = { SQS_WAGER_QUEUE_NAME: 'wager-transactions.fifo', SQS_WAGER_DLQ_NAME: 'wager-transactions-dlq.fifo' };

describe('loadWagerConsumerConfig', () => {
  test('só os nomes das filas são obrigatórios; o resto usa os padrões nomeados', () => {
    setEnv(names);
    const config = loadWagerConsumerConfig();
    expect(config.queues).toEqual({ queueName: 'wager-transactions.fifo', deadLetterQueueName: 'wager-transactions-dlq.fifo' });
    expect(config.consumer).toEqual({
      concurrency: CONSUMER_DEFAULTS.concurrency, batchSize: CONSUMER_DEFAULTS.batchSize, waitTimeSeconds: CONSUMER_DEFAULTS.waitTimeSeconds,
      visibilityTimeoutSeconds: CONSUMER_DEFAULTS.visibilityTimeoutSeconds, shutdownTimeoutMs: CONSUMER_DEFAULTS.shutdownTimeoutMs,
      receiveErrorPauseMs: CONSUMER_DEFAULTS.receiveErrorPauseMs,
    });
    expect(config.backoff).toEqual({ baseSeconds: CONSUMER_DEFAULTS.retryBaseSeconds, maxSeconds: CONSUMER_DEFAULTS.retryMaxSeconds });
  });

  test('os padrões respeitam os limites do SQS e a spec (long polling 20 s, lote 10, shutdown ~25 s)', () => {
    expect(CONSUMER_DEFAULTS.waitTimeSeconds).toBe(20);
    expect(CONSUMER_DEFAULTS.batchSize).toBe(10);
    expect(CONSUMER_DEFAULTS.shutdownTimeoutMs).toBe(25_000);
  });

  test('cada variável sobrescreve o seu campo', () => {
    setEnv({
      ...names, SQS_CONSUMER_CONCURRENCY: '3', SQS_BATCH_SIZE: '4', SQS_WAIT_TIME_SECONDS: '7', SQS_VISIBILITY_TIMEOUT_SECONDS: '60',
      SQS_RETRY_BASE_SECONDS: '2', SQS_RETRY_MAX_SECONDS: '90', SHUTDOWN_TIMEOUT_MS: '1000',
    });
    const config = loadWagerConsumerConfig();
    expect(config.consumer).toMatchObject({ concurrency: 3, batchSize: 4, waitTimeSeconds: 7, visibilityTimeoutSeconds: 60, shutdownTimeoutMs: 1000 });
    expect(config.backoff).toEqual({ baseSeconds: 2, maxSeconds: 90 });
  });

  test('falta de nome de fila falha cedo, com o nome da variável', () => {
    setEnv({ SQS_WAGER_DLQ_NAME: 'dlq.fifo' });
    expect(() => loadWagerConsumerConfig()).toThrow('SQS_WAGER_QUEUE_NAME');
    setEnv({ SQS_WAGER_QUEUE_NAME: 'q.fifo' });
    expect(() => loadWagerConsumerConfig()).toThrow('SQS_WAGER_DLQ_NAME');
  });

  test.each([
    ['lote acima do máximo do SQS', { SQS_BATCH_SIZE: '11' }],
    ['long polling acima de 20 s', { SQS_WAIT_TIME_SECONDS: '21' }],
    ['teto do backoff menor que a base', { SQS_RETRY_BASE_SECONDS: '10', SQS_RETRY_MAX_SECONDS: '5' }],
    ['valor que não é inteiro positivo', { SQS_CONSUMER_CONCURRENCY: 'muitos' }],
    ['zero', { SQS_CONSUMER_CONCURRENCY: '0' }],
  ])('rejeita %s', (_name, extra) => {
    setEnv({ ...names, ...extra });
    expect(() => loadWagerConsumerConfig()).toThrow();
  });
});
