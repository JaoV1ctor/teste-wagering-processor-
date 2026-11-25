/** O que cada repetição envia. Determinístico para a mesma semente; a ordem de chegada ao servidor continua dependendo da concorrência. */

export type PlannedKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';

/** Mulberry32: gerador pseudoaleatório pequeno e reproduzível (não é criptográfico, nem precisa ser). */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type Mix = readonly (readonly [PlannedKind, number])[];

/** Mistura dos cenários A e B. O REFUND precisa de uma BET já confirmada; sem nenhuma disponível, vira BET (o relatório conta o enviado). */
export const MIXED: Mix = [['BET', 55], ['WIN', 25], ['LOSS', 10], ['REFUND', 10]];
/** Cenários C e D: sem dependência entre operações. */
export const INDEPENDENT: Mix = [['BET', 60], ['WIN', 30], ['LOSS', 10]];

export function pickKind(mix: Mix, random: () => number): PlannedKind {
  const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
  let remaining = random() * total;
  for (const [kind, weight] of mix) {
    remaining -= weight;
    if (remaining < 0) return kind;
  }
  return mix.at(-1)![0];
}

/**
 * Cenário D: `total` envios, dos quais `replayPercent`% repetem uma operação anterior. Devolve, para cada envio, o índice da operação única.
 * A cópia entra pouco depois do original (até `window` posições): parte chega com o original ainda em voo, parte depois de ele terminar.
 */
export function scheduleReplays(total: number, replayPercent: number, window: number, random: () => number): number[] {
  const replays = Math.floor((total * replayPercent) / 100);
  const unique = total - replays;
  const copies = new Array<number>(unique).fill(0);
  for (let i = 0; i < replays; i += 1) {
    const chosen = Math.floor(random() * unique);
    copies[chosen] = copies[chosen]! + 1;
  }
  const slots: { operation: number; position: number }[] = [];
  copies.forEach((count, operation) => {
    slots.push({ operation, position: operation });
    for (let i = 0; i < count; i += 1) slots.push({ operation, position: operation + random() * window });
  });
  return slots.sort((a, b) => a.position - b.position).map((slot) => slot.operation);
}
