import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/inbox-message';

const at = new Date('2026-07-29T15:00:00.000Z');
const later = new Date('2026-07-29T15:00:01.000Z');
const hash = 'a'.repeat(64);

const receive = () => InboxMessage.receive({ consumerName: 'wager-consumer', messageId: 'msg-1', payloadHash: hash, now: at });

describe('InboxMessage', () => {
  test('nasce recebida e não processada', () => {
    const message = receive();
    expect(message.consumerName).toBe('wager-consumer');
    expect(message.messageId).toBe('msg-1');
    expect(message.receivedAt).toEqual(at);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed grava o instante; marcar duas vezes é erro de programação', () => {
    const message = receive();
    message.markProcessed(later);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(later);
    expect(() => message.markProcessed(later)).toThrow();
  });

  test('matchesPayload compara o hash do conteúdo', () => {
    const message = receive();
    expect(message.matchesPayload(hash)).toBe(true);
    expect(message.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('rejeita identificadores vazios e hash que não é SHA-256 hex', () => {
    expect(() => InboxMessage.receive({ consumerName: '', messageId: 'm', payloadHash: hash, now: at })).toThrow();
    expect(() => InboxMessage.receive({ consumerName: 'c', messageId: '', payloadHash: hash, now: at })).toThrow();
    expect(() => InboxMessage.receive({ consumerName: 'c', messageId: 'm', payloadHash: 'curto', now: at })).toThrow();
  });

  test('rehydrate restaura o estado sem revalidar transições', () => {
    const message = InboxMessage.rehydrate({ consumerName: 'c', messageId: 'm', payloadHash: hash, receivedAt: at, processedAt: later });
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(later);
  });
});
