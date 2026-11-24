// Configuração do publisher do outbox: lida e validada no boot (valor inválido derruba a subida, nunca o meio de um lote).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadOutboxConfig, OUTBOX_DEFAULTS } from '../../src/infrastructure/messaging/outbox-config';

const KEYS = ['SQS_EVENTS_QUEUE_NAME', 'OUTBOX_POLL_INTERVAL_MS', 'OUTBOX_BATCH_SIZE', 'OUTBOX_LEASE_MS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('loadOutboxConfig', () => {
  test('o nome da fila é obrigatório; o resto usa os padrões documentados', () => {
    expect(() => loadOutboxConfig()).toThrow('SQS_EVENTS_QUEUE_NAME');
    process.env['SQS_EVENTS_QUEUE_NAME'] = 'wager-events';
    expect(loadOutboxConfig()).toEqual({ queueName: 'wager-events', pollIntervalMs: 1000, batchSize: 50, leaseMs: 30_000 });
    expect(OUTBOX_DEFAULTS).toEqual({ pollIntervalMs: 1000, batchSize: 50, leaseMs: 30_000 });
  });

  test('cada variável sobrescreve o seu padrão', () => {
    process.env['SQS_EVENTS_QUEUE_NAME'] = 'q';
    process.env['OUTBOX_POLL_INTERVAL_MS'] = '250';
    process.env['OUTBOX_BATCH_SIZE'] = '7';
    process.env['OUTBOX_LEASE_MS'] = '90000';
    expect(loadOutboxConfig()).toEqual({ queueName: 'q', pollIntervalMs: 250, batchSize: 7, leaseMs: 90_000 });
  });

  test.each(['0', '-1', '1.5', 'abc', '10s'])('valor inválido %p derruba o boot', (bad) => {
    process.env['SQS_EVENTS_QUEUE_NAME'] = 'q';
    for (const key of ['OUTBOX_POLL_INTERVAL_MS', 'OUTBOX_BATCH_SIZE', 'OUTBOX_LEASE_MS'] as const) {
      process.env[key] = bad;
      expect(() => loadOutboxConfig()).toThrow(key);
      delete process.env[key];
    }
  });
});
