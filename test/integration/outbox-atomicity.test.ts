// Atomicidade com o outbox: wallet + transação + ledger + evento, tudo ou nada (README §11). Postgres REAL; a falha é injetada no repositório.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import type { Repositories, UnitOfWork } from '../../src/application/ports';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance, parkPendingReferences } from '../support/db';
import { outboxOfWallet, typesOf } from '../support/events';

const probe = createProbe(2);
let orm: MikroORM;
let real: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  real = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});
beforeEach(() => parkPendingReferences(probe));

type FailurePoint = 'transactions.addIdempotent' | 'wallets.saveBalance' | 'ledger.add' | 'outbox.add';

/** UnitOfWork real (mesma transação SQL) cujo repositório indicado lança. `after` deixa o método real rodar `after` vezes antes de falhar. */
function failingAt(point: FailurePoint, boom: Error, after = 0): UnitOfWork {
  const [repo, method] = point.split('.') as [keyof Repositories, string];
  return {
    read: (work) => real.read(work),
    run: (work) =>
      real.run((repos) => {
        let calls = 0;
        const original = (repos[repo] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!.bind(repos[repo]);
        const broken = Object.assign(Object.create(repos[repo]), {
          [method]: async (...args: unknown[]) => {
            if (calls++ >= after) throw boom;
            return original(...args);
          },
        });
        return work({ ...repos, [repo]: broken });
      }),
  };
}

const brl = (v: string) => Money.fromString(v, 'BRL');

describe.each<{ point: FailurePoint; after: number }>([
  { point: 'transactions.addIdempotent', after: 0 },
  { point: 'wallets.saveBalance', after: 0 },
  { point: 'ledger.add', after: 0 },
  { point: 'outbox.add', after: 0 }, // falha no 1º evento (Processed)
  { point: 'outbox.add', after: 1 }, // falha no 2º evento (BalanceChanged), com o 1º já inserido
])('falha em $point (depois de $after chamadas) no meio do processamento', ({ point, after }) => {
  test('nada persiste: wallet, version, ledger, transação e eventos intactos; depois o mesmo comando grava tudo, com 2 eventos', async () => {
    const wallet = await new CreateWalletUseCase(real).execute({ playerId: uuid(), initialBalance: brl('100.00') });
    const externalTransactionId = `ext-${uuid()}`;
    const cmd: ProcessWagerCommand = {
      idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
      walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl('30.00'),
    };
    const boom = new Error(`falha injetada em ${point}`);

    await expect(new ProcessWagerTransactionUseCase(failingAt(point, boom, after)).execute(cmd)).rejects.toBe(boom);

    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
    expect((await probe.query('select version from wallets where id = $1', [wallet.id])).rows).toEqual([{ version: 1 }]);
    expect((await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [externalTransactionId])).rows).toHaveLength(0);
    expect(await outboxOfWallet(probe, wallet.id)).toEqual([]); // nem o evento que já tinha sido inserido

    const retried = await new ProcessWagerTransactionUseCase(real).execute(cmd);
    expect(retried.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(typesOf(await outboxOfWallet(probe, wallet.id))).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
});

describe('worker de PENDING_REFERENCE', () => {
  test('falha ao gravar o evento: a pendência não é resolvida, o saldo não muda e não sobra evento órfão', async () => {
    const wallet = await new CreateWalletUseCase(real).execute({ playerId: uuid(), initialBalance: brl('100.00') });
    const betId = `ext-${uuid()}`;
    const refundId = `ext-${uuid()}`;
    const common = { providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', money: brl('30.00') };
    const useCase = new ProcessWagerTransactionUseCase(real);
    const early = await useCase.execute({
      ...common, idempotencyKey: `k-${refundId}`, externalTransactionId: refundId, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: betId,
    });
    expect(early.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    await useCase.execute({ ...common, idempotencyKey: `k-${betId}`, externalTransactionId: betId, kind: WagerTransactionKind.Bet });
    const eventsBefore = typesOf(await outboxOfWallet(probe, wallet.id));
    expect(eventsBefore).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);

    const boom = new Error('falha injetada no outbox do worker');
    const rethrow = (error: unknown): never => {
      throw error;
    };
    const broken = new ReprocessPendingReferencesUseCase(failingAt('outbox.add', boom), { onError: rethrow });
    await expect(broken.reprocessOne({ id: early.transaction.id, walletId: wallet.id })).rejects.toBe(boom);

    const { rows } = await probe.query<{ status: string }>('select status from wager_transactions where id = $1', [early.transaction.id]);
    expect(rows).toEqual([{ status: 'PENDING_REFERENCE' }]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect(typesOf(await outboxOfWallet(probe, wallet.id))).toEqual(eventsBefore);

    const good = new ReprocessPendingReferencesUseCase(real, { onError: rethrow });
    expect(await good.reprocessOne({ id: early.transaction.id, walletId: wallet.id })).toBe('processed');
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    expect(typesOf(await outboxOfWallet(probe, wallet.id))).toHaveLength(eventsBefore.length + 2);
  });
});
