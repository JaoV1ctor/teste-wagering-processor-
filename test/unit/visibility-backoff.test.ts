import { describe, expect, test } from 'bun:test';
import { visibilityBackoffSeconds } from '../../src/interface/sqs/visibility-backoff';

const options = { baseSeconds: 4, maxSeconds: 60 };

describe('visibilityBackoffSeconds', () => {
  test('cresce exponencialmente com o ApproximateReceiveCount (random = 1 dá o teto da faixa)', () => {
    const top = (count: number) => visibilityBackoffSeconds(count, options, () => 1);
    expect([1, 2, 3, 4, 5].map(top)).toEqual([4, 8, 16, 32, 60]);
  });

  test('jitter "equal": nunca abaixo de metade do valor exponencial, nunca acima dele', () => {
    expect(visibilityBackoffSeconds(3, options, () => 0)).toBe(8);
    expect(visibilityBackoffSeconds(3, options, () => 0.5)).toBe(12);
    for (let i = 0; i < 200; i += 1) {
      const delay = visibilityBackoffSeconds(2, options, Math.random);
      expect(delay).toBeGreaterThanOrEqual(4);
      expect(delay).toBeLessThanOrEqual(8);
    }
  });

  test('respeita o teto mesmo para contagens altas', () => {
    expect(visibilityBackoffSeconds(40, options, () => 1)).toBe(60);
    expect(visibilityBackoffSeconds(1000, options, () => 1)).toBe(60);
  });

  test('o resultado é inteiro (ChangeMessageVisibility aceita segundos inteiros)', () => {
    expect(Number.isInteger(visibilityBackoffSeconds(1, { baseSeconds: 5, maxSeconds: 60 }, () => 0))).toBe(true);
  });

  test('base 0 desliga o atraso (usado nos testes de DLQ)', () => {
    expect(visibilityBackoffSeconds(3, { baseSeconds: 0, maxSeconds: 0 }, Math.random)).toBe(0);
  });

  test('contagem inválida é erro de programação', () => {
    expect(() => visibilityBackoffSeconds(0, options, Math.random)).toThrow(RangeError);
    expect(() => visibilityBackoffSeconds(1.5, options, Math.random)).toThrow(RangeError);
  });
});
