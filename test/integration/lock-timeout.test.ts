// lock_timeout (ARCHITECTURE: "Espera por lock"): quem espera uma wallet travada não fica pendurado; 55P03 é transitório. Postgres REAL.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import type pg from 'pg';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { TransientInfrastructureError } from '../../src/application/errors';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

const LOCK_TIMEOUT_MS = 150;
const probe = createProbe(4);
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  // Um único cliente no pool: a mesma conexão é reutilizada, então o teste enxerga vazamento de configuração entre transações.
  orm = await MikroORM.init({ ...createOrmConfig(), pool: { min: 1, max: 1 }, extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: LOCK_TIMEOUT_MS, retry: { attempts: 2, baseDelayMs: 1 } });
  process.env['LOCK_TIMEOUT_MS'] = String(LOCK_TIMEOUT_MS);
  api = await startApi();
});
afterAll(async () => {
  delete process.env['LOCK_TIMEOUT_MS'];
  await api.close();
  await probe.end();
  await orm.close();
});

const brl = (v: string) => Money.fromString(v, 'BRL');

/** Outra conexão segura a linha da wallet até `release()`, como uma transação longa ou travada faria. */
async function holdWalletLock(walletId: string): Promise<{ release: () => Promise<void> }> {
  const client: pg.PoolClient = await probe.connect();
  await client.query('begin');
  await client.query('select id from wallets where id = $1 for no key update', [walletId]);
  return {
    release: async () => {
      await client.query('rollback');
      client.release();
    },
  };
}

describe('lock_timeout no UnitOfWork', () => {
  test('wallet travada por outro: falha transitória no prazo do lock_timeout, nada persiste; liberado o lock, o mesmo comando passa', async () => {
    const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('100.00') });
    const externalTransactionId = `ext-${uuid()}`;
    const cmd: ProcessWagerCommand = {
      idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
      walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl('30.00'),
    };
    const useCase = new ProcessWagerTransactionUseCase(uow);

    const holder = await holdWalletLock(wallet.id);
    const startedAt = Date.now();
    const error = await useCase.execute(cmd).catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;
    await holder.release();

    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).cause).toMatchObject({ code: '55P03' });
    expect(elapsed).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS); // esperou de fato o lock_timeout (2 tentativas)
    expect(elapsed).toBeLessThan(5_000);
    expect((await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [externalTransactionId])).rows).toHaveLength(0);

    const retried = await useCase.execute(cmd);
    expect(retried.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('SET LOCAL: o valor vale só dentro da transação; a conexão devolvida ao pool volta ao padrão (sem vazar para outras)', async () => {
    await uow.run(({ wallets }) => wallets.findById(uuid()));
    const after = await orm.em.getConnection().execute<{ lock_timeout: string }[]>('show lock_timeout');
    expect(after).toEqual([{ lock_timeout: '0' }]);
  });
});

describe('POST /wagering/transactions com a wallet travada', () => {
  test('503 SERVICE_UNAVAILABLE com Retry-After (o provedor pode reenviar); liberado o lock, o reenvio da mesma chave dá 201', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });

    const holder = await holdWalletLock(wallet.walletId);
    const blocked = await submit(api, payload, defaultKey(payload));
    await holder.release();

    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(blocked.headers.get('retry-after')).toBe('1');

    const resent = await submit(api, payload, defaultKey(payload));
    expect(resent.status).toBe(201);
    expect(resent.body.idempotentReplay).toBe(false);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });
});
