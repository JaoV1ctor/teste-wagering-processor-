import { backoffDelayMs } from './backoff';

/**
 * Backoff do publisher do outbox. Estimativas justificadas em docs/ARCHITECTURE.md:
 *  - base 1 s: uma falha isolada (timeout, throttling) costuma passar na tentativa seguinte, sem atrasar o evento por muito tempo.
 *  - teto 60 s: com o SQS fora por minutos, cada evento tenta no máximo 1x por minuto (sem martelar o serviço quando ele volta),
 *    e o atraso depois da recuperação fica limitado a ~1,5 min.
 *  - jitter de 0 a +50%: eventos que falharam juntos (a mesma queda) não voltam todos no mesmo instante.
 * Não há limite de tentativas: um evento do outbox é um fato já commitado e nunca é descartado; `attempts` só cresce, e quem observa vê o atraso.
 */
export const OUTBOX_RETRY = {
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  maxJitterRatio: 0.5,
} as const;

export function outboxRetryDelayMs(attempts: number, random: () => number): number {
  return backoffDelayMs(attempts, OUTBOX_RETRY, random);
}
