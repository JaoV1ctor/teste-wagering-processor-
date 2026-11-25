// As peças puras do teste de carga: se o percentil ou o plano estiverem errados, o relatório inteiro mente.
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../scripts/load/config';
import { MIXED, pickKind, randomFrom, scheduleReplays } from '../../scripts/load/plan';
import { runPool } from '../../scripts/load/pool';
import { distribution, median, percentile, variation } from '../../scripts/load/stats';

const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('percentis (nearest-rank, conjunto completo)', () => {
  test('em 1..100, p50 = 50, p95 = 95, p99 = 99 e p100 = máximo', () => {
    const values = oneTo(100);
    expect([50, 95, 99, 100].map((p) => percentile(values, p))).toEqual([50, 95, 99, 100]);
  });

  test('devolve sempre uma amostra observada, sem interpolar', () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20, 30], 95)).toBe(30);
    expect(percentile([7], 99)).toBe(7);
  });

  test('distribution ordena numericamente sem alterar a entrada; sem amostra é undefined, nunca zero', () => {
    const samples = [100, 9, 25];
    expect(distribution(samples)).toEqual({ count: 3, p50: 25, p95: 100, p99: 100, max: 100 });
    expect(samples).toEqual([100, 9, 25]);
    expect(distribution([])).toBeUndefined();
  });

  test('percentil inválido ou conjunto vazio lançam', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  test('mediana e variação entre repetições', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(variation([90, 100, 120])).toEqual({ median: 100, min: 90, max: 120, spreadPercent: 30 });
    expect(variation([0, 0, 0]).spreadPercent).toBeUndefined();
  });
});

describe('plano de envios', () => {
  test('a mesma semente gera a mesma sequência; sementes diferentes, outra', () => {
    const take = (seed: number) => Array.from({ length: 20 }, randomFrom(seed));
    expect(take(7)).toEqual(take(7));
    expect(take(7)).not.toEqual(take(8));
    expect(take(7).every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test('a mistura respeita os pesos', () => {
    const random = randomFrom(1);
    const picked = Array.from({ length: 20_000 }, () => pickKind(MIXED, random));
    const share = (kind: string) => picked.filter((value) => value === kind).length / picked.length;
    expect(share('BET')).toBeCloseTo(0.55, 1);
    expect(share('REFUND')).toBeCloseTo(0.1, 1);
  });

  test.each([[1000, 30], [100, 0], [7, 90]])('%d envios com %d%% de reenvios: contagem exata e todo reenvio depois do original', (total, percent) => {
    const sends = scheduleReplays(total, percent, 16, randomFrom(3));
    const unique = new Set(sends);
    expect(sends).toHaveLength(total);
    expect(total - unique.size).toBe(Math.floor((total * percent) / 100));
    // A 1ª aparição de cada operação segue a ordem das operações: nenhuma cópia passa à frente do original.
    const firsts = [...unique];
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  });
});

describe('pool de concorrência', () => {
  test('nunca passa do limite, executa todas e devolve na ordem das tarefas', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runPool(3, oneTo(10).map((n) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return n;
    }));
    expect(results).toEqual(oneTo(10));
    expect(peak).toBe(3);
  });
});

describe('configuração', () => {
  test('padrão e smoke; --smoke vale mais que o ambiente', () => {
    expect(loadConfig({})).toMatchObject({ profile: 'default', repetitions: 3, scenarios: ['A', 'B', 'C', 'D'] });
    expect(loadConfig({ LOAD_PROFILE: 'default' }, ['--smoke'])).toMatchObject({ profile: 'smoke', repetitions: 1 });
  });

  test('lê os parâmetros e filtra cenários, na ordem canônica', () => {
    const config = loadConfig({ LOAD_WALLETS: '7', LOAD_REQUESTS: '11', LOAD_CONCURRENCY: '3', LOAD_REPLAY_PERCENT: '50', LOAD_SCENARIOS: 'd, a' });
    expect(config).toMatchObject({ wallets: 7, requests: 11, concurrency: 3, replayPercent: 50, scenarios: ['A', 'D'] });
  });

  test.each([
    [{ LOAD_REQUESTS: '0' }], [{ LOAD_CONCURRENCY: 'muitas' }], [{ LOAD_REPLAY_PERCENT: '100' }], [{ LOAD_SCENARIOS: 'A,Z' }], [{ LOAD_PROFILE: 'turbo' }],
  ])('valor inválido derruba: %p', (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
