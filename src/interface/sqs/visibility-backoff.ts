export interface VisibilityBackoffOptions {
  /** Atraso exponencial da 1ª falha, em segundos. */
  baseSeconds: number;
  /** Teto do atraso, em segundos. */
  maxSeconds: number;
}

/**
 * Quanto a mensagem fica invisível depois de uma falha transitória (SPEC §8.1): `min(teto, base · 2^(recebimentos-1))` com jitter "equal",
 * isto é, uniforme entre metade do valor e o valor inteiro. O piso de metade evita reentrega imediata (martelar um Postgres que acabou
 * de cair); o jitter espalha mensagens que falharam juntas. `ApproximateReceiveCount` conta o recebimento atual (1 na primeira entrega).
 * `ChangeMessageVisibility` só aceita segundos inteiros.
 */
export function visibilityBackoffSeconds(receiveCount: number, { baseSeconds, maxSeconds }: VisibilityBackoffOptions, random: () => number): number {
  if (!Number.isInteger(receiveCount) || receiveCount < 1) throw new RangeError('receiveCount deve ser um inteiro >= 1');
  const exponential = Math.min(maxSeconds, baseSeconds * 2 ** Math.min(receiveCount - 1, 30));
  return Math.ceil(exponential / 2 + (random() * exponential) / 2);
}
