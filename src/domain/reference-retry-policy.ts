import { backoffDelayMs } from './backoff';

/**
 * Política do worker de PENDING_REFERENCE. Os números são estimativas justificadas em docs/ARCHITECTURE.md.
 *
 * `attempts` conta as avaliações da referência que terminaram sem achá-la, incluindo a inicial feita na submissão.
 * Com 1 avaliação inicial + 8 reprocessamentos, a espera total (sem jitter) é 1+2+4+8+16+32+60+60 = 183s; com jitter de até +50%, até ~4,5 min.
 */
export const REFERENCE_RETRY = {
  maxReprocessAttempts: 8,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  maxJitterRatio: 0.5,
} as const;

/** Espera até a próxima avaliação, dado quantas já ocorreram (`attempts >= 1`): ver `backoffDelayMs`. */
export function referenceRetryDelayMs(attempts: number, random: () => number): number {
  return backoffDelayMs(attempts, REFERENCE_RETRY, random);
}

/** Com `attempts` avaliações sem referência, a próxima que falhar rejeita em vez de reagendar. */
export function hasExhaustedReferenceAttempts(attempts: number): boolean {
  return attempts >= REFERENCE_RETRY.maxReprocessAttempts;
}
