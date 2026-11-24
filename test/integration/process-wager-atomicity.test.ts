// Atomicidade de ProcessWagerTransaction: wallet + transação + ledger, tudo ou nada. Postgres REAL; a falha é injetada no repositório.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import type { Repositories, UnitOfWork } from '../../src/application/ports';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';

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

type FailurePoint = 'transactions.addIdempotent' | 'wallets.saveBalance' | 'ledger.add';

/** UnitOfWork real (mesma transação SQL) cujo repositório indicado lança depois de os anteriores já terem escrito. */
function failingAt(point: FailurePoint, boom: Error): UnitOfWork {
  const [repo, method] = point.split('.') as [keyof Repositories, string];
  return {
    read: (work) => real.read(work),
    run: (work) =>
      real.run((repos) => {
        const broken = Object.assign(Object.create(repos[repo]), { [method]: async () => { throw boom; } });
        return work({ ...repos, [repo]: broken });
      }),
  };
}

const brl = (v: string) => Money.fromString(v, 'BRL');

describe.each<FailurePoint>(['transactions.addIdempotent', 'wallets.saveBalance', 'ledger.add'])('falha em %s no meio do processamento', (point) => {
  test('nada persiste: wallet, version e ledger intactos, nenhuma transação gravada; depois o mesmo comando funciona', async () => {
    const wallet = await new CreateWalletUseCase(real).execute({ playerId: uuid(), initialBalance: brl('100.00') });
    const externalTransactionId = `ext-${uuid()}`;
    const cmd: ProcessWagerCommand = {
      idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
      walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl('30.00'),
    };
    const boom = new Error(`falha injetada em ${point}`);

    await expect(new ProcessWagerTransactionUseCase(failingAt(point, boom)).execute(cmd)).rejects.toBe(boom);

    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
    const { rows: version } = await probe.query('select version from wallets where id = $1', [wallet.id]);
    expect(version).toEqual([{ version: 1 }]);
    const { rows: transactions } = await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [externalTransactionId]);
    expect(transactions).toHaveLength(0);

    const retried = await new ProcessWagerTransactionUseCase(real).execute(cmd);
    expect(retried.idempotentReplay).toBe(false);
    expect(retried.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });
});
