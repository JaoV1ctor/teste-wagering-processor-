// Texto que o banco não consegue guardar como veio (U+0000 e surrogate solto) é recusado na borda, no HTTP e na fila.
import { describe, expect, test } from 'bun:test';
import { IdempotencyKeyHeader, ProviderTransactionParams, SubmitTransactionBody } from '../../src/interface/http/wagering.dto';
import { parseWagerMessage } from '../../src/interface/sqs/wager-transaction-message';

const data = {
  providerId: 'p', externalTransactionId: 'e', playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'r', gameId: 'g', kind: 'WIN', money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: 'b',
};
const FIELDS = ['providerId', 'externalTransactionId', 'roundId', 'gameId', 'referenceExternalTransactionId'];
const BAD = ['a\u0000', 'a\uD800', '\uDC00a'];
const message = (envelope: Record<string, unknown>, change: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: 'm', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data: { ...data, idempotencyKey: 'k', ...change }, ...envelope,
  });

describe('texto não armazenável', () => {
  test.each(FIELDS)('%s é recusado no corpo HTTP e na mensagem', (field) => {
    for (const value of BAD) {
      expect(SubmitTransactionBody.safeParse({ ...data, [field]: value }).success).toBe(false);
      expect(() => parseWagerMessage(message({}, { [field]: value }))).toThrow();
    }
  });

  test('ids de rota, Idempotency-Key, idempotencyKey e messageId também', () => {
    for (const value of BAD) {
      expect(ProviderTransactionParams.safeParse({ providerId: value, externalTransactionId: 'e' }).success).toBe(false);
      expect(IdempotencyKeyHeader.safeParse(value).success).toBe(false);
      expect(() => parseWagerMessage(message({}, { idempotencyKey: value }))).toThrow();
      expect(() => parseWagerMessage(message({ messageId: value }))).toThrow();
    }
  });

  test('pares de surrogates (emoji) e outros caracteres Unicode continuam aceitos', () => {
    const value = '🎲 \u202E é \uFFFF\r\n';
    expect(SubmitTransactionBody.parse({ ...data, roundId: value }).roundId).toBe(value);
    expect(parseWagerMessage(message({ messageId: value }, { roundId: value })).messageId).toBe(value);
  });
});
