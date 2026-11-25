// Repositórios de wallet (lockWallet) e de transação (addIdempotent, consultas) sobre Postgres REAL. Nada é mockado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { IdempotencyConflictError } from '../../src/application/errors';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { FailureCode } from '../../src/domain/failure-code';
import { createProbe, divergentWallets, ensureSchema } from '../support/db';

const probe = createProbe(2);
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  const divergent = await divergentWallets(probe);
  await probe.end();
  await orm.close();
  expect(divergent).toEqual([]); // invariante final: wallet.balance == saldo reconstruído pelo ledger
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const openWallet = (balance: string): Promise<Wallet> => new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl(balance) });

/** LOSS já PROCESSED: não move saldo, então basta a transação para exercitar o repositório. */
function finishedLoss(wallet: Wallet, key: string, external: string): WagerTransaction {
  const now = new Date();
  const tx = WagerTransaction.create({
    id: uuid(), providerId: 'provider-b', externalTransactionId: external, idempotencyKey: key, payloadHash: 'c'.repeat(64),
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Loss, money: brl('1.00'), now,
  });
  tx.markProcessed({ observedBalance: wallet.balance, at: now });
  return tx;
}

describe('WagerTransactionRepository.addIdempotent', () => {
  test('chave nova grava (true); a mesma chave não grava e não lança (false)', async () => {
    const wallet = await openWallet('10.00');
    const key = `k-${uuid()}`;
    const ext = `e-${uuid()}`;
    const first = finishedLoss(wallet, key, ext);

    const results = await uow.run(async ({ transactions }) => [
      await transactions.addIdempotent(first),
      await transactions.addIdempotent(finishedLoss(wallet, key, ext)),
    ]);

    expect(results).toEqual([true, false]);
    const { rows } = await probe.query('select id from wager_transactions where idempotency_key = $1', [key]);
    expect(rows).toEqual([{ id: first.id }]);
  });

  test('texto com aspas, barra, ? e $1 é gravado literalmente (a interpolação do ORM escapa e não reinterpreta marcadores)', async () => {
    const wallet = await openWallet('10.00');
    const nasty = `e-'); drop table wallets; -- ? \ $1 ?? ${uuid()}`;
    const tx = finishedLoss(wallet, `k-${nasty}`, nasty);
    await uow.run(({ transactions }) => transactions.addIdempotent(tx));

    const { rows } = await probe.query('select external_transaction_id, idempotency_key from wager_transactions where id = $1', [tx.id]);
    expect(rows).toEqual([{ external_transaction_id: nasty, idempotency_key: `k-${nasty}` }]);
    expect((await probe.query('select 1 from wallets where id = $1', [wallet.id])).rows).toHaveLength(1);
  });

  test('mesma identidade do provedor com outra chave lança IdempotencyConflictError', async () => {
    const wallet = await openWallet('10.00');
    const ext = `e-${uuid()}`;
    await uow.run(({ transactions }) => transactions.addIdempotent(finishedLoss(wallet, `k-${uuid()}`, ext)));

    await expect(uow.run(({ transactions }) => transactions.addIdempotent(finishedLoss(wallet, `k-${uuid()}`, ext)))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('consultas por chave, por identidade do provedor e por id devolvem o domínio; ausente devolve undefined', async () => {
    const wallet = await openWallet('10.00');
    const key = `k-${uuid()}`;
    const ext = `e-${uuid()}`;
    const stored = finishedLoss(wallet, key, ext);
    await uow.run(({ transactions }) => transactions.addIdempotent(stored));

    const found = await uow.read(async ({ transactions }) => ({
      byKey: await transactions.findByIdempotencyKey(key),
      byProvider: await transactions.findByProviderExternalId('provider-b', ext),
      byId: await transactions.findById(stored.id),
      missing: await transactions.findByIdempotencyKey(`nao-existe-${uuid()}`),
    }));

    expect(found.byKey?.toState()).toEqual(stored.toState());
    expect(found.byProvider?.id).toBe(stored.id);
    expect(found.byId?.id).toBe(stored.id);
    expect(found.missing).toBeUndefined();
  });
});

describe('WalletRepository.lockWallet', () => {
  test('devolve a wallet atual; inexistente devolve undefined', async () => {
    const wallet = await openWallet('42.00');
    const { locked, missing } = await uow.run(async ({ wallets }) => ({
      locked: await wallets.lockWallet(wallet.id),
      missing: await wallets.lockWallet(uuid()),
    }));
    expect(locked?.toState()).toEqual(wallet.toState());
    expect(missing).toBeUndefined();
  });

  test('o id vai em parâmetro: texto malicioso é recusado pelo banco e nunca vira SQL (injeção)', async () => {
    await openWallet('1.00'); // existe ao menos uma wallet que uma concatenação ingênua devolveria
    const malicious = "00000000-0000-0000-0000-000000000000' or true --";
    await expect(uow.run(({ wallets }) => wallets.lockWallet(malicious))).rejects.toThrow();
  });

  test('saveBalance persiste saldo e version da wallet travada', async () => {
    const wallet = await openWallet('100.00');
    await uow.run(async ({ wallets, transactions, ledger }) => {
      const locked = await wallets.lockWallet(wallet.id);
      if (!locked) throw new Error('wallet sumiu');
      const now = new Date();
      const tx = WagerTransaction.create({
        id: uuid(), providerId: 'provider-b', externalTransactionId: `e-${uuid()}`, idempotencyKey: `k-${uuid()}`, payloadHash: 'd'.repeat(64),
        walletId: wallet.id, playerId: wallet.playerId, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Win, money: brl('5.00'), now,
      });
      const entry = locked.credit(brl('5.00'), { entryId: uuid(), transactionId: tx.id, at: now });
      tx.markProcessed({ observedBalance: locked.balance, at: now });
      await transactions.addIdempotent(tx);
      await wallets.saveBalance(locked);
      await ledger.add(entry);
    });

    const { rows } = await probe.query('select balance::text, version from wallets where id = $1', [wallet.id]);
    expect(rows).toEqual([{ balance: '105.00', version: 2 }]);
  });
});

/** REFUND com referência por id externo, ainda sem a transação referenciada: nasce PENDING e é parqueada como PENDING_REFERENCE. */
function pendingRefund(wallet: Wallet, referenceExternalTransactionId: string, now: Date, nextAttemptAt: Date): WagerTransaction {
  const tx = WagerTransaction.create({
    id: uuid(), providerId: 'provider-b', externalTransactionId: `e-${uuid()}`, idempotencyKey: `k-${uuid()}`, payloadHash: 'e'.repeat(64),
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Refund, money: brl('1.00'),
    referenceExternalTransactionId, now,
  });
  tx.markPendingReference(nextAttemptAt, now);
  return tx;
}

describe('WagerTransactionRepository.update', () => {
  test('PENDING_REFERENCE -> PROCESSED: grava estado final, referência, saldo observado e tentativas; a identidade não muda', async () => {
    const wallet = await openWallet('10.00');
    const referenced = finishedLoss(wallet, `k-${uuid()}`, `e-${uuid()}`);
    const refund = pendingRefund(wallet, referenced.externalTransactionId, new Date(), new Date(Date.now() + 1000));
    await uow.run(async ({ transactions }) => {
      await transactions.addIdempotent(referenced);
      await transactions.addIdempotent(refund);
    });

    const at = new Date();
    await uow.run(async ({ transactions }) => {
      const loaded = await transactions.findById(refund.id);
      if (!loaded) throw new Error('sumiu');
      loaded.markProcessed({ observedBalance: brl('10.00'), at, referenceTransactionId: referenced.id });
      await transactions.update(loaded);
    });

    const after = await uow.read(({ transactions }) => transactions.findById(refund.id));
    expect(after?.status).toBe(WagerTransactionStatus.Processed);
    expect(after?.referenceTransactionId).toBe(referenced.id);
    expect(after?.observedBalance?.toString()).toBe('10.00');
    expect(after?.processedAt?.getTime()).toBe(at.getTime());
    expect(after?.attempts).toBe(1);
    expect(after?.payloadHash).toBe(refund.payloadHash);
    expect(after?.idempotencyKey).toBe(refund.idempotencyKey);
  });

  test('transação terminal não aceita update: o trigger do banco recusa (o domínio já não permite, o schema garante)', async () => {
    const wallet = await openWallet('10.00');
    const finished = finishedLoss(wallet, `k-${uuid()}`, `e-${uuid()}`);
    await uow.run(({ transactions }) => transactions.addIdempotent(finished));

    const forged = WagerTransaction.rehydrate({ ...finished.toState(), status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientBalance, processedAt: undefined });
    await expect(uow.run(({ transactions }) => transactions.update(forged))).rejects.toThrow(/terminal/);
  });
});

describe('WagerTransactionRepository.hasEffectiveReversal', () => {
  test('só reversão PROCESSED conta: REJECTED e PENDING_REFERENCE não; sem reversão, false', async () => {
    const wallet = await openWallet('10.00');
    const referenced = finishedLoss(wallet, `k-${uuid()}`, `e-${uuid()}`);
    const rejected = pendingRefund(wallet, referenced.externalTransactionId, new Date(), new Date());
    await uow.run(async ({ transactions }) => {
      await transactions.addIdempotent(referenced);
      await transactions.addIdempotent(rejected);
    });
    const has = () => uow.read(({ transactions }) => transactions.hasEffectiveReversal(referenced.id));
    expect(await has()).toBe(false);

    await uow.run(async ({ transactions }) => {
      const loaded = await transactions.findById(rejected.id);
      loaded?.reject(FailureCode.AmountMismatch, brl('10.00'), new Date());
      if (loaded) await transactions.update(loaded);
    });
    expect(await has()).toBe(false);

    const effective = pendingRefund(wallet, referenced.externalTransactionId, new Date(), new Date());
    await uow.run(async ({ transactions }) => {
      await transactions.addIdempotent(effective);
      const loaded = await transactions.findById(effective.id);
      loaded?.markProcessed({ observedBalance: brl('10.00'), at: new Date(), referenceTransactionId: referenced.id });
      if (loaded) await transactions.update(loaded);
    });
    expect(await has()).toBe(true);
  });
});
