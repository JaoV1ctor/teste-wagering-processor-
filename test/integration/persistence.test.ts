// Repositórios + unit-of-work sobre Postgres REAL. Nada é mockado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../src/application/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, seedCredits } from '../support/db';

const queries: string[] = [];
const probe = createProbe();
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator], debug: ['query'], logger: (msg: string) => queries.push(msg) });
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

const brl = (v: string) => Money.fromString(v, 'BRL');

/** Wallet aberta com OPENING processada, como o caso de uso `CreateWallet` faz. */
function opened(initial: string, playerId = uuid()) {
  const now = new Date();
  const openingTransactionId = uuid();
  const { wallet, openingEntry } = Wallet.create({
    id: uuid(), playerId, initialBalance: brl(initial), openingTransactionId, openingEntryId: uuid(), now,
  });
  const transaction = WagerTransaction.create({
    id: openingTransactionId, providerId: 'internal', externalTransactionId: `opening:${wallet.id}`, idempotencyKey: `opening:${wallet.id}`,
    payloadHash: 'b'.repeat(64), walletId: wallet.id, playerId, roundId: 'opening', gameId: 'opening',
    kind: WagerTransactionKind.Opening, money: brl(initial), now,
  });
  transaction.markProcessed({ observedBalance: brl(initial), at: now });
  return { wallet, openingEntry, transaction };
}

const count = async (table: string, column: string, id: string): Promise<number> => {
  const { rows } = await probe.query<{ n: string }>(`select count(*)::text as n from ${table} where ${column} = $1`, [id]);
  return Number.parseInt(rows[0]?.n ?? '0', 10);
};

describe('MikroOrmUnitOfWork', () => {
  test('grava wallet, transação e lançamento juntos e relê como domínio', async () => {
    const { wallet, openingEntry, transaction } = opened('1000.00');
    await uow.run(async ({ wallets, transactions, ledger }) => {
      await wallets.add(wallet);
      await transactions.add(transaction);
      if (openingEntry) await ledger.add(openingEntry);
    });

    const { storedWallet, storedTx, records } = await uow.read(async ({ wallets, transactions, ledger }) => ({
      storedWallet: await wallets.findById(wallet.id),
      storedTx: await transactions.findById(transaction.id),
      records: await ledger.listByWallet(wallet.id, { limit: 10 }),
    }));
    expect(storedWallet).toBeInstanceOf(Wallet);
    expect(storedWallet?.toState()).toEqual(wallet.toState());
    expect(storedTx?.status).toBe(WagerTransactionStatus.Processed);
    expect(storedTx?.observedBalance?.toString()).toBe('1000.00');
    expect(records).toHaveLength(1);
    expect(records[0]?.entry.direction).toBe(LedgerDirection.Credit);
    expect(records[0]?.entry.balanceAfter.toString()).toBe('1000.00');
    expect(typeof records[0]?.seq).toBe('bigint');
  });

  test('ordem dos INSERTs: wallet -> transação -> ledger (SPEC §6)', async () => {
    const { wallet, openingEntry, transaction } = opened('10.00');
    queries.length = 0;
    await uow.run(async ({ wallets, transactions, ledger }) => {
      await wallets.add(wallet);
      await transactions.add(transaction);
      if (openingEntry) await ledger.add(openingEntry);
    });
    const inserts = queries.map((q) => /insert into "(\w+)"/i.exec(q)?.[1]).filter((t): t is string => t !== undefined);
    expect(inserts).toEqual(['wallets', 'wager_transactions', 'wallet_ledger_entries']);
  });

  test('erro no meio da unit-of-work: ROLLBACK, nada persiste', async () => {
    const { wallet, transaction } = opened('50.00');
    const boom = new Error('falha depois de gravar wallet e transação');
    await expect(uow.run(async ({ wallets, transactions }) => {
      await wallets.add(wallet);
      await transactions.add(transaction);
      throw boom;
    })).rejects.toBe(boom);
    expect(await count('wallets', 'id', wallet.id)).toBe(0);
    expect(await count('wager_transactions', 'wallet_id', wallet.id)).toBe(0);
  });

  test('wallet sem lançamento mas com saldo falha no COMMIT (check deferido do schema) e nada persiste', async () => {
    const { wallet } = opened('50.00');
    await expect(uow.run(async ({ wallets }) => { await wallets.add(wallet); })).rejects.toThrow(/divergente do ledger/);
    expect(await count('wallets', 'id', wallet.id)).toBe(0);
  });

  test('mesmo player+moeda: WalletAlreadyExistsError e nenhum resíduo da segunda tentativa', async () => {
    const playerId = uuid();
    const first = opened('10.00', playerId);
    await uow.run(async ({ wallets, transactions, ledger }) => {
      await wallets.add(first.wallet);
      await transactions.add(first.transaction);
      if (first.openingEntry) await ledger.add(first.openingEntry);
    });

    const second = opened('20.00', playerId);
    await expect(uow.run(async ({ wallets, transactions, ledger }) => {
      await wallets.add(second.wallet);
      await transactions.add(second.transaction);
      if (second.openingEntry) await ledger.add(second.openingEntry);
    })).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(await count('wallets', 'id', second.wallet.id)).toBe(0);
    expect(await count('wager_transactions', 'wallet_id', second.wallet.id)).toBe(0);
  });

  test('findById devolve undefined quando a wallet não existe', async () => {
    expect(await uow.read(({ wallets }) => wallets.findById(uuid()))).toBeUndefined();
  });
});

describe('LedgerRepository.listByWallet', () => {
  test('ordena por seq, filtra por wallet, respeita afterSeq e limit', async () => {
    const mine = opened('10.00');
    const other = opened('5.00');
    for (const { wallet, transaction, openingEntry } of [mine, other]) {
      await uow.run(async ({ wallets, transactions, ledger }) => {
        await wallets.add(wallet);
        await transactions.add(transaction);
        if (openingEntry) await ledger.add(openingEntry);
      });
    }
    await seedCredits(probe, mine.wallet.id, 5);

    const all = await uow.read(({ ledger }) => ledger.listByWallet(mine.wallet.id, { limit: 100 }));
    expect(all).toHaveLength(6);
    expect(all.every((r) => r.entry.walletId === mine.wallet.id)).toBe(true);
    const seqs = all.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const firstTwo = await uow.read(({ ledger }) => ledger.listByWallet(mine.wallet.id, { limit: 2 }));
    expect(firstTwo.map((r) => r.entry.id)).toEqual(all.slice(0, 2).map((r) => r.entry.id));

    const after = await uow.read(({ ledger }) => ledger.listByWallet(mine.wallet.id, { afterSeq: all[2]?.seq, limit: 100 }));
    expect(after.map((r) => r.entry.id)).toEqual(all.slice(3).map((r) => r.entry.id));
  });
});
