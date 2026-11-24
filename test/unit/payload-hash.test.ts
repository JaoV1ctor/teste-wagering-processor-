import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash, type PayloadHashInput } from '../../src/application/payload-hash';

const payload: PayloadHashInput = {
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

  // Vetor fixo: sha256 de
  // {"externalTransactionId":"ext-1","gameId":"g1","kind":"BET","money":{"amount":"10.00","currency":"BRL"},"playerId":"p1","providerId":"prov","roundId":"r1","walletId":"w1"}
  // calculado fora do código (sha256sum). Protege o algoritmo documentado contra mudança silenciosa: mudar o hash invalida todas as chaves já gravadas.
  test('vetor fixo do algoritmo documentado (JSON canônico + SHA-256)', () => {
    expect(computePayloadHash(payload)).toBe('c35c7153b3f48996a7edd07ab2e00c8b4c871d1b2511ed96f6d5a3194fb0606a');
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
    ['jogo', { gameId: 'g2' }],
    ['wallet', { walletId: 'w2' }],
    ['player', { playerId: 'p2' }],
    ['provedor', { providerId: 'prov-2' }],
    ['id externo', { externalTransactionId: 'ext-2' }],
  ])('muda quando %s muda', (_name, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });

  test('"10.00" e "10.0" são payloads diferentes: a normalização é feita antes, por Money.toProps()', () => {
    expect(computePayloadHash({ ...payload, money: { amount: '10.0', currency: 'BRL' } })).not.toBe(computePayloadHash(payload));
  });
});
