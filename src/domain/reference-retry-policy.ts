/**
 * Política do worker de PENDING_REFERENCE (SPEC §3.10, README §7.1). Os números são estimativas justificadas em docs/ARCHITECTURE.md.
 *
 * `attempts` conta as avaliações da referência que terminaram sem achá-la, incluindo a inicial feita na submissão.
 * Com 1 avaliação inicial + 8 reprocessamentos, a espera total (sem jitter) é 1+2+4+8+16+32+60+60 = 183s; com jitter de até +50%, até ~4,5 min.
 */
export const REFERENCE_RETRY = {
  maxReprocessAttempts: 8,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  /** Fração máxima somada à espera: espalha reprocessos que nasceram juntos para não voltarem todos no mesmo instante. */
  maxJitterRatio: 0.5,
} as const;

/** Espera até a próxima avaliação, dado quantas já ocorreram (`attempts >= 1`): min(teto, base·2^(attempts-1)) mais jitter. */
export function referenceRetryDelayMs(attempts: number, random: () => number): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts deve ser um inteiro >= 1');
  const exponential = Math.min(REFERENCE_RETRY.maxDelayMs, REFERENCE_RETRY.baseDelayMs * 2 ** (attempts - 1));
  return Math.floor(exponential * (1 + random() * REFERENCE_RETRY.maxJitterRatio));
}

/** Com `attempts` avaliações sem referência, a próxima que falhar rejeita em vez de reagendar. */
export function hasExhaustedReferenceAttempts(attempts: number): boolean {
  return attempts >= REFERENCE_RETRY.maxReprocessAttempts;
}
