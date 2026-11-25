// OutboxMessage e a política de backoff do publisher. Domínio puro: relógio e aleatoriedade entram por argumento.
import { describe, expect, test } from 'bun:test';
import { InvalidOutboxMessageError } from '../../src/domain/errors';
import type { IntegrationEvent } from '../../src/domain/events/integration-event';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { Money } from '../../src/domain/money';
import { OUTBOX_RETRY, outboxRetryDelayMs } from '../../src/domain/outbox-retry-policy';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';

const at = new Date('2026-03-01T12:00:00.000Z');
const EVENT_ID = 'e0000000-0000-4000-8000-000000000001';

function event(): IntegrationEvent<unknown> {
  const tx = WagerTransaction.create({
    id: '33333333-3333-4333-8333-333333333333', providerId: 'p', externalTransactionId: 'x', idempotencyKey: 'p:x', payloadHash: 'a'.repeat(64),
    walletId: '11111111-1111-4111-8111-111111111111', playerId: '22222222-2222-4222-8222-222222222222', roundId: 'r', gameId: 'g',
    kind: WagerTransactionKind.Loss, money: Money.fromString('5.00', 'BRL'), now: at,
  });
  tx.markProcessed({ observedBalance: Money.fromString('5.00', 'BRL'), at });
  return WagerTransactionProcessed.from(tx, { eventId: EVENT_ID, correlationId: 'c', occurredAt: at });
}

describe('OutboxMessage', () => {
  test('enqueue: id = eventId, payload = envelope serializado, vence já, sem tentativas nem publicação', () => {
    const message = OutboxMessage.enqueue(event());
    expect(message.id).toBe(EVENT_ID);
    expect(message.aggregateId).toBe('33333333-3333-4333-8333-333333333333');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload).toEqual({ ...event().toJSON() });
    expect(message.occurredAt).toEqual(at);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(at);
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
  });

  test('markPublished fecha a mensagem e não repete', () => {
    const message = OutboxMessage.enqueue(event());
    const publishedAt = new Date(at.getTime() + 500);
    message.markPublished(publishedAt);
    expect(message.publishedAt).toEqual(publishedAt);
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(publishedAt)).toThrow(InvalidOutboxMessageError);
    expect(() => message.scheduleRetry(publishedAt, () => 0)).toThrow(InvalidOutboxMessageError);
  });

  test('scheduleRetry soma a tentativa e agenda com backoff exponencial a partir de agora', () => {
    const message = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      message.scheduleRetry(at, () => 0); // sem jitter
      delays.push(message.nextAttemptAt.getTime() - at.getTime());
    }
    expect(message.attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(message.isPending()).toBe(true);
  });

  test('rehydrate restaura o estado sem revalidar', () => {
    const publishedAt = new Date(at.getTime() + 5000);
    const message = OutboxMessage.rehydrate({
      id: EVENT_ID, aggregateId: 'agg', eventType: 'X', payload: { a: 1 }, occurredAt: at, attempts: 3, nextAttemptAt: publishedAt, publishedAt,
    });
    expect([message.id, message.aggregateId, message.eventType, message.payload, message.occurredAt, message.attempts, message.nextAttemptAt, message.publishedAt])
      .toEqual([EVENT_ID, 'agg', 'X', { a: 1 }, at, 3, publishedAt, publishedAt]);
    expect(message.isPending()).toBe(false);
  });
});

describe('outboxRetryDelayMs', () => {
  test('dobra a cada tentativa a partir da base e respeita o teto', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => outboxRetryDelayMs(n, () => 0))).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test('jitter soma de 0 a +50% sobre o valor já limitado pelo teto', () => {
    expect(outboxRetryDelayMs(3, () => 0)).toBe(4000);
    expect(outboxRetryDelayMs(3, () => 0.5)).toBe(5000);
    expect(outboxRetryDelayMs(3, () => 0.999999)).toBeLessThan(4000 * (1 + OUTBOX_RETRY.maxJitterRatio));
    expect(outboxRetryDelayMs(30, () => 0.999999)).toBeLessThan(OUTBOX_RETRY.maxDelayMs * (1 + OUTBOX_RETRY.maxJitterRatio));
  });

  test('tentativas inválidas são erro de programação', () => {
    expect(() => outboxRetryDelayMs(0, () => 0)).toThrow(RangeError);
    expect(() => outboxRetryDelayMs(1.5, () => 0)).toThrow(RangeError);
  });
});
