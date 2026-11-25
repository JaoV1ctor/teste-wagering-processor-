// Atomicidade das QUATRO escritas de uma entrada por fila: wallet, ledger, inbox e outbox (mais a transação). Postgres REAL; a falha é
// injetada em um método do repositório real, dentro da mesma transação SQL, e o resultado é lido por outra conexão.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import type { Repositories, UnitOfWork } from '../../src/application/ports';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { expectEventsConsistentWithLedger, outboxOfWallet, typesOf } from '../support/events';

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

const brl = (v: string) => Money.fromString(v, 'BRL');
const consumerName = `atomicity-${uuid()}`;

type Point = 'inbox.addIfAbsent' | 'transactions.addIdempotent' | 'wallets.saveBalance' | 'ledger.add' | 'outbox.add' | 'inbox.markProcessed';

/** Deixa o método real rodar `after` vezes e então lança; com `afterWrite`, grava de verdade ANTES de lançar. */
function failingAt(point: Point, boom: Error, { after = 0, afterWrite = false } = {}): UnitOfWork {
  const [repo, method] = point.split('.') as [keyof Repositories, string];
  return {
    read: (work) => real.read(work),
    run: (work) =>
      real.run((repos) => {
        let calls = 0;
        const original = (repos[repo] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!.bind(repos[repo]);
        const broken = Object.assign(Object.create(repos[repo]), {
          [method]: async (...args: unknown[]) => {
            if (calls++ < after) return original(...args);
            if (afterWrite) await original(...args);
            throw boom;
          },
        });
        return work({ ...repos, [repo]: broken });
      }),
  };
}

/** Tudo o que a entrada pela fila pode ter deixado no banco. */
async function persisted(walletId: string, externalTransactionId: string, messageId: string) {
  const count = async (sql: string, params: unknown[]) => (await probe.query(sql, params)).rows.length;
  return {
    balance: await ledgerBalance(probe, walletId),
    version: (await probe.query<{ version: number }>('select version from wallets where id = $1', [walletId])).rows[0]?.version,
    transactions: await count('select 1 from wager_transactions where external_transaction_id = $1', [externalTransactionId]),
    inbox: await count('select 1 from inbox_messages where consumer_name = $1 and message_id = $2', [consumerName, messageId]),
    events: typesOf(await outboxOfWallet(probe, walletId)),
  };
}

const untouched = { balance: { stored: '100.00', rebuilt: '100.00', entries: 1 }, version: 1, transactions: 0, inbox: 0, events: [] };

describe.each<[string, Point, { after?: number; afterWrite?: boolean }]>([
  ['depois de gravar o inbox', 'inbox.addIfAbsent', { afterWrite: true }],
  ['ao gravar a transação', 'transactions.addIdempotent', {}],
  ['ao atualizar a wallet', 'wallets.saveBalance', {}],
  ['depois de gravar o lançamento', 'ledger.add', { afterWrite: true }],
  ['no 1º evento do outbox', 'outbox.add', {}],
  ['no 2º evento do outbox, com o 1º já inserido', 'outbox.add', { after: 1 }],
  ['no último passo, depois de tudo escrito', 'inbox.markProcessed', { afterWrite: true }],
])('falha %s', (_name, point, options) => {
  test('wallet, ledger, inbox e outbox não persistem; a reentrega grava os quatro uma única vez', async () => {
    const wallet = await new CreateWalletUseCase(real).execute({ playerId: uuid(), initialBalance: brl('100.00') });
    const externalTransactionId = `ext-${uuid()}`;
    const messageId = `msg-${uuid()}`;
    const command: ProcessWagerCommand = {
      idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
      walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl('30.00'),
    };
    const boom = new Error(`falha injetada em ${point}`);

    await expect(new ProcessWagerTransactionUseCase(failingAt(point, boom, options)).execute(command, { consumerName, messageId })).rejects.toBe(boom);

    expect(await persisted(wallet.id, externalTransactionId, messageId)).toEqual(untouched);

    await new ProcessWagerTransactionUseCase(real).execute(command, { consumerName, messageId });

    expect(await persisted(wallet.id, externalTransactionId, messageId)).toEqual({
      balance: { stored: '70.00', rebuilt: '70.00', entries: 2 }, version: 2, transactions: 1, inbox: 1,
      events: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    });
    await expectEventsConsistentWithLedger(probe, wallet.id);
  });
});
