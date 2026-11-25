/** Estatística do experimento. Todos os percentis saem do conjunto COMPLETO de amostras, sem histograma nem amostragem. */

export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Percentil pelo método do posto mais próximo (nearest-rank): o menor valor tal que pelo menos `p`% das amostras são menores ou iguais a ele.
 * Sempre devolve uma amostra observada, sem interpolar.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) throw new RangeError('percentil de conjunto vazio');
  if (p <= 0 || p > 100) throw new RangeError(`percentil fora de (0, 100]: ${p}`);
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[rank - 1]!;
}

/** `undefined` quando não há amostra: um relatório nunca mostra 0 no lugar de "não medido". */
export function distribution(samples: readonly number[]): Distribution | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1)! };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mediana de conjunto vazio');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface Variation {
  median: number;
  min: number;
  max: number;
  /** Amplitude (máximo - mínimo) em % da mediana; `undefined` se a mediana é zero. */
  spreadPercent: number | undefined;
}

/** Resumo entre repetições do mesmo cenário. */
export function variation(values: readonly number[]): Variation {
  const middle = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { median: middle, min, max, spreadPercent: middle === 0 ? undefined : ((max - min) / middle) * 100 };
}
