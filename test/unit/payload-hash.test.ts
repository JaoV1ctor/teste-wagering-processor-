import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash } from '../../src/application/payload-hash';

const payload = {
  providerId: 'prov', externalTransactionId: 'ext-1', playerId: 'p1', walletId: 'w1', roundId: 'r1', gameId: 'g1',
  kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('ordena chaves recursivamente', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('preserva a ordem de arrays', () => {
    expect(canonicalJson({ a: [2, 1] })).toBe('{"a":[2,1]}');
  });
});

describe('computePayloadHash', () => {
  test('SHA-256 em hex (64 caracteres)', () => {
    expect(computePayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('independe da ordem das chaves', () => {
    const reordered = { money: { currency: 'BRL', amount: '10.00' }, kind: 'BET', gameId: 'g1', roundId: 'r1', walletId: 'w1', playerId: 'p1', externalTransactionId: 'ext-1', providerId: 'prov' };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test.each([
    ['valor', { money: { amount: '10.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '10.00', currency: 'USD' } }],
    ['tipo', { kind: 'WIN' }],
    ['rodada', { roundId: 'r2' }],
  ])('muda quando %s muda', (_name, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });
});
