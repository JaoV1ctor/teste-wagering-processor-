// wager_lock_conflicts_total, wager_retries_total{source="database"} e wager_wallet_lock_wait_seconds com conflitos REAIS no Postgres:
// um deadlock de verdade (duas transações travando duas wallets em ordem inversa) e um lock_timeout de verdade (wallet travada por outra conexão).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { TransientInfrastructureError } from '../../src/application/errors';
import type { Repositories } from '../../src/application/ports';
import { Money } from '../../src/domain/money';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, divergentWallets, ensureSchema } from '../support/db';
import { type MetricsPage, parseMetrics, total } from '../support/metrics';

const probe = createProbe(4);
let orm: MikroORM;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
});
afterAll(async () => {
  const divergent = await divergentWallets(probe);
  await probe.end();
  await orm.close();
  expect(divergent).toEqual([]); // invariante final: wallet.balance == saldo reconstruído pelo ledger
});

const newWallet = async (uow: MikroOrmUnitOfWork): Promise<string> =>
  (await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: Money.fromString('10.00', 'BRL') })).id;

const page = async (metrics: Metrics): Promise<MetricsPage> => {
  const text = await metrics.registry.metrics();
  return { text, samples: parseMetrics(text) };
};

describe('lock_timeout: wallet travada por outra conexão', () => {
  test('cada tentativa que estoura o prazo é um conflito; as tentativas seguintes são retries; esgotado vira 503 (TransientInfrastructureError)', async () => {
    const metrics = new Metrics();
    const uow = new MikroOrmUnitOfWork(orm, { observer: metrics, lockTimeoutMs: 200, retry: { attempts: 3, baseDelayMs: 1 } });
    const walletId = await newWallet(uow);

    const holder = await probe.connect();
    await holder.query('BEGIN');
    await holder.query('select 1 from wallets where id = $1 for no key update', [walletId]);
    try {
      await expect(uow.run(({ wallets }) => wallets.lockWallet(walletId))).rejects.toBeInstanceOf(TransientInfrastructureError);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    const stuck = await page(metrics);
    expect(total(stuck, 'wager_lock_conflicts_total')).toBe(3); // as 3 tentativas estouraram o lock_timeout
    expect(total(stuck, 'wager_retries_total', { source: 'database' })).toBe(2); // 3 tentativas = 2 retries
    expect(total(stuck, 'wager_wallet_lock_wait_seconds_count')).toBe(3); // a espera é medida mesmo quando o lock falha
    expect(total(stuck, 'wager_wallet_lock_wait_seconds_sum')).toBeGreaterThanOrEqual(0.5); // 3 x ~0,2 s esperando

    await uow.run(({ wallets }) => wallets.lockWallet(walletId)); // liberada: passa de primeira, sem novo conflito nem retry
    const released = await page(metrics);
    expect(total(released, 'wager_lock_conflicts_total')).toBe(3);
    expect(total(released, 'wager_retries_total', { source: 'database' })).toBe(2);
    expect(total(released, 'wager_wallet_lock_wait_seconds_count')).toBe(4);
  });
});

describe('deadlock real (40P01)', () => {
  test('duas transações em ordem inversa de lock: o Postgres derruba uma; vira 1 conflito + 1 retry e as duas terminam', async () => {
    const metrics = new Metrics();
    const uow = new MikroOrmUnitOfWork(orm, { observer: metrics, retry: { attempts: 3, baseDelayMs: 5 } });
    const a = await newWallet(uow);
    const b = await newWallet(uow);

    // Só a 1ª tentativa de cada transação espera a outra segurar o primeiro lock; o retry da vítima não espera ninguém.
    let holding = 0;
    let release!: () => void;
    const bothHolding = new Promise<void>((resolve) => (release = resolve));
    const crossing = (first: string, second: string) => {
      let attempts = 0;
      return async ({ wallets }: Repositories): Promise<void> => {
        await wallets.lockWallet(first);
        if (attempts++ === 0) {
          holding += 1;
          if (holding === 2) release();
          await bothHolding;
        }
        await wallets.lockWallet(second);
      };
    };

    await Promise.all([uow.run(crossing(a, b)), uow.run(crossing(b, a))]);

    const result = await page(metrics);
    expect(total(result, 'wager_lock_conflicts_total')).toBe(1);
    expect(total(result, 'wager_retries_total', { source: 'database' })).toBe(1);
  });
});
