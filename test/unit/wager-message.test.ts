import { describe, expect, test } from 'bun:test';
import { MalformedMessageError, parseWagerMessage, UnknownMessageTypeError } from '../../src/interface/sqs/wager-transaction-message';

const data = {
  providerId: 'provider-a', externalTransactionId: 'transaction-123', idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', roundId: 'round-987',
  gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
};
const envelope = (overrides: Record<string, unknown> = {}) => ({
  messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data, ...overrides,
});
const parse = (value: unknown) => parseWagerMessage(typeof value === 'string' ? value : JSON.stringify(value));

describe('parseWagerMessage', () => {
  test('mensagem do enunciado vira messageId + comando com Money (nunca number)', () => {
    const parsed = parse(envelope());
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.command.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.command.walletId).toBe(data.walletId);
    expect(parsed.command.money.toString()).toBe('25.00');
    expect(parsed.command.money.currency).toBe('BRL');
    expect('referenceExternalTransactionId' in parsed.command).toBe(false);
  });

  test('referenceExternalTransactionId passa para o comando', () => {
    const parsed = parse(envelope({ data: { ...data, kind: 'REFUND', referenceExternalTransactionId: 'transaction-1' } }));
    expect(parsed.command.referenceExternalTransactionId).toBe('transaction-1');
  });

  test('type desconhecido é UnknownMessageTypeError (mesmo com data inválido)', () => {
    expect(() => parse(envelope({ type: 'Outra' }))).toThrow(UnknownMessageTypeError);
    expect(() => parse(envelope({ type: 'Outra', data: 42 }))).toThrow(UnknownMessageTypeError);
  });

  test.each([
    ['corpo que não é JSON', 'isso não é json'],
    ['JSON que não é objeto', '[1,2]'],
    ['messageId ausente', { type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data }],
    ['messageId longo demais (limite do MessageDeduplicationId)', envelope({ messageId: 'x'.repeat(129) })],
    ['occurredAt que não é data ISO', envelope({ occurredAt: 'ontem' })],
    ['data ausente', { messageId: 'm', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z' }],
    ['campo extra no envelope', envelope({ extra: 1 })],
    ['campo extra em data', envelope({ data: { ...data, extra: 1 } })],
    ['walletId que não é uuid', envelope({ data: { ...data, walletId: "x'; drop table wallets;--" } })],
    ['idempotencyKey ausente', envelope({ data: { ...data, idempotencyKey: undefined } })],
    ['kind OPENING (interno)', envelope({ data: { ...data, kind: 'OPENING' } })],
    ['kind desconhecido', envelope({ data: { ...data, kind: 'JACKPOT' } })],
    ['valor como number', envelope({ data: { ...data, money: { amount: 25, currency: 'BRL' } } })],
    ['valor com 3 casas decimais', envelope({ data: { ...data, money: { amount: '10.005', currency: 'BRL' } } })],
    ['valor zero', envelope({ data: { ...data, money: { amount: '0.00', currency: 'BRL' } } })],
    ['valor negativo', envelope({ data: { ...data, money: { amount: '-1.00', currency: 'BRL' } } })],
    ['REFUND sem referência', envelope({ data: { ...data, kind: 'REFUND' } })],
    ['BET com referência', envelope({ data: { ...data, referenceExternalTransactionId: 'x' } })],
    ['referência para si mesma', envelope({ data: { ...data, kind: 'WIN', referenceExternalTransactionId: 'transaction-123' } })],
  ])('malformada (%s) é MalformedMessageError', (_name, value) => {
    expect(() => parse(value)).toThrow(MalformedMessageError);
  });

  test('o erro de payload malformado não carrega o corpo da mensagem', () => {
    let caught: unknown;
    try {
      parse(envelope({ data: { ...data, playerId: 'segredo-do-jogador' } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MalformedMessageError);
    expect((caught as Error).message).not.toContain('segredo-do-jogador');
  });
});
