// Política do worker de PENDING_REFERENCE (SPEC §3.10): 8 reprocessamentos, backoff exponencial com teto e jitter.
import { describe, expect, test } from 'bun:test';
import { hasExhaustedReferenceAttempts, REFERENCE_RETRY, referenceRetryDelayMs } from '../../src/domain/reference-retry-policy';

describe('referenceRetryDelayMs (sem jitter)', () => {
  test('1s, 2s, 4s, 8s, 16s, 32s e depois o teto de 60s', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((attempts) => referenceRetryDelayMs(attempts, () => 0));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
  });

  test('jitter só soma, até +50%: nunca antecipa e nunca passa de 1,5x', () => {
    expect(referenceRetryDelayMs(3, () => 0.999999)).toBeLessThan(6000);
    expect(referenceRetryDelayMs(3, () => 0.5)).toBe(5000);
    expect(referenceRetryDelayMs(8, () => 0.5)).toBe(75000);
  });

  test('o tempo total até esgotar (8 esperas) fica entre 3 e 4,6 minutos', () => {
    const total = (random: () => number) =>
      Array.from({ length: REFERENCE_RETRY.maxReprocessAttempts }, (_, i) => referenceRetryDelayMs(i + 1, random)).reduce((a, b) => a + b, 0);
    expect(total(() => 0)).toBe(183_000);
    expect(total(() => 0.999999)).toBeLessThan(275_000);
  });

  test('tentativas inválidas (zero ou negativa) são erro de programação', () => {
    expect(() => referenceRetryDelayMs(0, () => 0)).toThrow();
    expect(() => referenceRetryDelayMs(-1, () => 0)).toThrow();
  });
});

describe('hasExhaustedReferenceAttempts', () => {
  test('esgota ao chegar em 8 tentativas', () => {
    expect([0, 1, 7].map(hasExhaustedReferenceAttempts)).toEqual([false, false, false]);
    expect([8, 9].map(hasExhaustedReferenceAttempts)).toEqual([true, true]);
  });
});
