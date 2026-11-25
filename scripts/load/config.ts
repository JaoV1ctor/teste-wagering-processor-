/** Parâmetros do experimento, por variável de ambiente. Valor inválido derruba a execução: nunca cai em silêncio no padrão. */

export const SCENARIO_IDS = ['A', 'B', 'C', 'D'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface LoadConfig {
  profile: 'default' | 'smoke';
  scenarios: ScenarioId[];
  /** Wallets dos cenários A, C e D (o B usa uma só). */
  wallets: number;
  /** Requisições (ou mensagens) medidas por repetição. */
  requests: number;
  /** Requisições (ou mensagens) de aquecimento, descartadas. */
  warmupRequests: number;
  /** Requisições HTTP em voo ao mesmo tempo (gerador de laço fechado). */
  concurrency: number;
  /** Cenário D: porcentagem das requisições que reenviam uma operação com a mesma Idempotency-Key. */
  replayPercent: number;
  repetitions: number;
  /** Processos da aplicação (cada um com HTTP, consumidor, worker e publisher). */
  instances: number;
  seed: number;
}

const PROFILES: Record<LoadConfig['profile'], Omit<LoadConfig, 'profile' | 'scenarios'>> = {
  default: { wallets: 100, requests: 1500, warmupRequests: 200, concurrency: 32, replayPercent: 30, repetitions: 3, instances: 2, seed: 1 },
  smoke: { wallets: 5, requests: 60, warmupRequests: 10, concurrency: 8, replayPercent: 30, repetitions: 1, instances: 1, seed: 1 },
};

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number, { min, max }: { min: number; max: number }): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d{1,9}$/.test(raw) ? parseInt(raw, 10) : undefined;
  if (value === undefined || value < min || value > max) throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}; recebido "${raw}"`);
  return value;
}

export function loadConfig(env: Env, args: readonly string[] = []): LoadConfig {
  const profile = args.includes('--smoke') ? 'smoke' : (env['LOAD_PROFILE'] ?? 'default');
  if (profile !== 'default' && profile !== 'smoke') throw new Error(`LOAD_PROFILE deve ser "default" ou "smoke"; recebido "${profile}"`);
  const base = PROFILES[profile];

  const requested = (env['LOAD_SCENARIOS'] ?? SCENARIO_IDS.join(',')).split(',').map((id) => id.trim().toUpperCase());
  const unknown = requested.filter((id) => !(SCENARIO_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) throw new Error(`LOAD_SCENARIOS aceita ${SCENARIO_IDS.join(',')}; desconhecido: ${unknown.join(',')}`);

  return {
    profile,
    scenarios: SCENARIO_IDS.filter((id) => requested.includes(id)),
    wallets: integer(env, 'LOAD_WALLETS', base.wallets, { min: 1, max: 10_000 }),
    requests: integer(env, 'LOAD_REQUESTS', base.requests, { min: 1, max: 1_000_000 }),
    warmupRequests: integer(env, 'LOAD_WARMUP_REQUESTS', base.warmupRequests, { min: 0, max: 100_000 }),
    concurrency: integer(env, 'LOAD_CONCURRENCY', base.concurrency, { min: 1, max: 1000 }),
    replayPercent: integer(env, 'LOAD_REPLAY_PERCENT', base.replayPercent, { min: 0, max: 90 }),
    repetitions: integer(env, 'LOAD_REPETITIONS', base.repetitions, { min: 1, max: 20 }),
    instances: integer(env, 'LOAD_INSTANCES', base.instances, { min: 1, max: 16 }),
    seed: integer(env, 'LOAD_SEED', base.seed, { min: 0, max: 999_999_999 }),
  };
}
