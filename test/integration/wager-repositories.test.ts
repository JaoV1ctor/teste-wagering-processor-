// Repositórios de wallet (lockWallet) e de transação (addIdempotent, consultas) sobre Postgres REAL. Nada é mockado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { IdempotencyConflictError } from '../../src/application/errors';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema } from '../support/db';

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
