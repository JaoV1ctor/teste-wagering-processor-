export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fração máxima somada à espera: espalha tentativas que nasceram juntas para não voltarem todas no mesmo instante. */
  maxJitterRatio: number;
}

/** Espera até a próxima tentativa, dado quantas já ocorreram (`attempts >= 1`): min(teto, base·2^(attempts-1)) mais jitter de 0 a `maxJitterRatio`. */
export function backoffDelayMs(attempts: number, policy: BackoffPolicy, random: () => number): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts deve ser um inteiro >= 1');
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempts - 1));
  return Math.floor(exponential * (1 + random() * policy.maxJitterRatio));
}
