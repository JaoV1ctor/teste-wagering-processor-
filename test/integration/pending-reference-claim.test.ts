// Claim por lease do worker de PENDING_REFERENCE: FOR UPDATE SKIP LOCKED, lotes disjuntos. Postgres REAL.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, parkPendingReferences } from '../support/db';

const probe = createProbe(2);
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const openWallet = (balance: string): Promise<Wallet> => new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl(balance) });

function pendingRefund(wallet: Wallet, referenceExternalTransactionId: string, now: Date, nextAttemptAt: Date): WagerTransaction {
  const tx = WagerTransaction.create({
    id: uuid(), providerId: 'provider-b', externalTransactionId: `e-${uuid()}`, idempotencyKey: `k-${uuid()}`, payloadHash: 'e'.repeat(64),
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Refund, money: brl('1.00'),
    referenceExternalTransactionId, now,
  });
  tx.markPendingReference(nextAttemptAt, now);
  return tx;
}

describe('WagerTransactionRepository.claimDuePendingReference', () => {
  test('claims concorrentes recebem lotes DISJUNTOS (FOR UPDATE SKIP LOCKED): cada transação é reivindicada uma única vez', async () => {
    await parkPendingReferences(probe);
    const wallet = await openWallet('10.00');
    const base = new Date(Date.now() - 60_000);
    const created = Array.from({ length: 12 }, () => pendingRefund(wallet, `ausente-${uuid()}`, base, base));
    await uow.run(async ({ transactions }) => {
      for (const tx of created) await transactions.addIdempotent(tx);
    });

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 30_000);
    const claim = (limit: number) => uow.run(({ transactions }) => transactions.claimDuePendingReference(now, limit, leaseUntil));
    const claims = await Promise.all(Array.from({ length: 4 }, () => claim(5)));
    claims.push(await claim(100)); // o que sobrou, se algum claim concorrente pulou linhas travadas

    const ids = claims.flat().map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length); // nenhuma reivindicada duas vezes
    expect(ids).toHaveLength(12);
    expect(new Set(ids)).toEqual(new Set(created.map((tx) => tx.id)));
    expect(claims.flat().every((claim) => claim.walletId === wallet.id)).toBe(true);
    const { rows } = await probe.query<{ n: string }>('select count(*)::text as n from wager_transactions where wallet_id = $1 and next_attempt_at = $2', [wallet.id, leaseUntil]);
    expect(rows).toEqual([{ n: '12' }]);
  });
});
