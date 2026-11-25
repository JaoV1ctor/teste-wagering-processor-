/** O que o experimento lê do banco e das métricas em volta de cada repetição. */
import type pg from 'pg';
import { scrapeMetrics } from './client';
import { type Distribution, distribution } from './stats';

export async function waitUntil(description: string, condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado (${timeoutMs} ms) esperando: ${description}`);
    await Bun.sleep(100);
  }
}

export async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from (${sql}) as counted`, params);
  return parseInt(rows[0]!.n, 10);
}

/** Espera o publisher alcançar o que foi commitado. Devolve quantos segundos isso levou a partir da chamada. */
export async function drainOutbox(pool: pg.Pool): Promise<number> {
  const started = Bun.nanoseconds();
  await waitUntil('outbox publicado', async () => (await count(pool, 'select 1 from outbox_messages where published_at is null')) === 0, 300_000);
  return (Bun.nanoseconds() - started) / 1e9;
}

/** Lag de cada evento criado na janela: `published_at - occurred_at` (os dois do relógio da aplicação), em ms. */
export async function outboxLag(pool: pg.Pool, from: Date, to: Date): Promise<Distribution | undefined> {
  const { rows } = await pool.query<{ lag: string }>(
    `select (extract(epoch from (published_at - occurred_at)) * 1000)::text as lag from outbox_messages
      where published_at is not null and occurred_at >= $1 and occurred_at <= $2`,
    [from, to],
  );
  return distribution(rows.map((row) => parseFloat(row.lag)));
}

export interface Counters {
  /** Deadlocks (40P01), serialização (40001) e lock_timeout (55P03) vistos pela aplicação. */
  lockConflicts: number;
  retriesDatabase: number;
  retriesQueue: number;
  duplicates: number;
  deadLettered: number;
  lockWaitCount: number;
  lockWaitSeconds: number;
  processingCount: number;
  processingSeconds: number;
  /** Contador do próprio Postgres. */
  deadlocks: number;
}

export async function readCounters(urls: readonly string[], pool: pg.Pool): Promise<Counters> {
  const metrics = await scrapeMetrics(urls);
  const value = (series: string) => metrics.get(series) ?? 0;
  const { rows } = await pool.query<{ n: string }>('select deadlocks::text as n from pg_stat_database where datname = current_database()');
  return {
    lockConflicts: value('wager_lock_conflicts_total'),
    retriesDatabase: value('wager_retries_total{source="database"}'),
    retriesQueue: value('wager_retries_total{source="queue"}'),
    duplicates: value('wager_duplicates_total'),
    deadLettered: value('wager_dlq_messages_total'),
    lockWaitCount: value('wager_wallet_lock_wait_seconds_count'),
    lockWaitSeconds: value('wager_wallet_lock_wait_seconds_sum'),
    processingCount: value('wager_processing_duration_seconds_count'),
    processingSeconds: value('wager_processing_duration_seconds_sum'),
    deadlocks: parseInt(rows[0]!.n, 10),
  };
}

export function difference(after: Counters, before: Counters): Counters {
  const result = { ...after };
  for (const key of Object.keys(result) as (keyof Counters)[]) result[key] = after[key] - before[key];
  return result;
}
