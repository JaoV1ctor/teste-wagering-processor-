// Inbox (consumerName, messageId) na MESMA transação SQL do processamento (SPEC §6 passo 3). Postgres REAL; a falha é injetada no repositório.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { IdempotencyConflictError, InboxPayloadConflictError } from '../../src/application/errors';
import type { Repositories, UnitOfWork } from '../../src/application/ports';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';

const probe = createProbe(4);
let orm: MikroORM;
let real: MikroOrmUnitOfWork;
let useCase: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  real = new MikroOrmUnitOfWork(orm);
  useCase = new ProcessWagerTransactionUseCase(real);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const consumerName = `consumer-${uuid()}`;

async function wagerFor(amount = '30.00') {
  const wallet = await new CreateWalletUseCase(real).execute({ playerId: uuid(), initialBalance: brl('100.00') });
  const externalTransactionId = `ext-${uuid()}`;
  const command: ProcessWagerCommand = {
    idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl(amount),
  };
  return { wallet, command };
}

const inboxRows = async (messageId: string, consumer = consumerName) =>
  (await probe.query<{ processed_at: Date | null; payload_hash: string }>(
    'select processed_at, payload_hash from inbox_messages where consumer_name = $1 and message_id = $2', [consumer, messageId],
  )).rows;

describe('inbox na transação do processamento', () => {
  test('1ª entrega processa e grava a mensagem do inbox já marcada como processada', async () => {
    const { wallet, command } = await wagerFor();
    const messageId = `msg-${uuid()}`;

    const result = await useCase.execute(command, { consumerName, messageId });

    expect('transaction' in result && result.transaction.status).toBe(WagerTransactionStatus.Processed);
    const rows = await inboxRows(messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('mesma messageId e mesmo conteúdo, outra idempotencyKey: duplicata pelo inbox, nada é reprocessado', async () => {
    const { wallet, command } = await wagerFor();
    const messageId = `msg-${uuid()}`;
    await useCase.execute(command, { consumerName, messageId });

    // A chave muda, então o fast-path por idempotência NÃO acerta: só o inbox impede o 2º débito.
    const again = await useCase.execute({ ...command, idempotencyKey: `${command.idempotencyKey}:outra` }, { consumerName, messageId });

    expect(again).toEqual({ duplicateMessage: true });
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect((await probe.query('select 1 from wager_transactions where wallet_id = $1 and kind = $2', [wallet.id, 'BET'])).rows).toHaveLength(1);
  });

  test('mesma messageId com conteúdo diferente: InboxPayloadConflictError e nada novo persiste', async () => {
    const { wallet, command } = await wagerFor();
    const messageId = `msg-${uuid()}`;
    await useCase.execute(command, { consumerName, messageId });
    const other = { ...command, idempotencyKey: `${command.idempotencyKey}:2`, externalTransactionId: `${command.externalTransactionId}-2`, money: brl('40.00') };

    await expect(useCase.execute(other, { consumerName, messageId })).rejects.toBeInstanceOf(InboxPayloadConflictError);

    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect((await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [other.externalTransactionId])).rows).toHaveLength(0);
  });

  test('o dedup é por consumidor: a mesma messageId em outro consumidor não é duplicata do inbox', async () => {
    const { command } = await wagerFor();
    const messageId = `msg-${uuid()}`;
    await useCase.execute(command, { consumerName, messageId });

    // Mesmo conteúdo e mesma chave: quem segura é a idempotência (replay), não o inbox do outro consumidor.
    const other = await useCase.execute(command, { consumerName: `${consumerName}-b`, messageId });

    expect('duplicateMessage' in other).toBe(false);
    expect('idempotentReplay' in other && other.idempotentReplay).toBe(true);
  });

  test('messageId nova com a mesma idempotencyKey: replay, e a nova mensagem não debita de novo', async () => {
    const { wallet, command } = await wagerFor();
    await useCase.execute(command, { consumerName, messageId: `msg-${uuid()}` });

    const result = await useCase.execute(command, { consumerName, messageId: `msg-${uuid()}` });

    expect('idempotentReplay' in result && result.idempotentReplay).toBe(true);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('mesma chave de idempotência com payload diferente continua sendo conflito (409), com inbox', async () => {
    const { command } = await wagerFor();
    await useCase.execute(command, { consumerName, messageId: `msg-${uuid()}` });

    await expect(useCase.execute({ ...command, money: brl('31.00') }, { consumerName, messageId: `msg-${uuid()}` })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  test('BET sem saldo: REJECTED é resultado de negócio e o inbox é gravado junto', async () => {
    const { command } = await wagerFor('500.00');
    const messageId = `msg-${uuid()}`;

    const result = await useCase.execute(command, { consumerName, messageId });

    expect('transaction' in result && result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(await inboxRows(messageId)).toHaveLength(1);
  });

  test('execute sem origem (HTTP) não toca o inbox', async () => {
    const count = async () => (await probe.query<{ n: string }>('select count(*)::text as n from inbox_messages where consumer_name = $1', [consumerName])).rows[0]?.n;
    const before = await count();
    const { command } = await wagerFor();
    await useCase.execute(command);
    expect(await count()).toBe(before);
  });
});

type FailurePoint = 'inbox.markProcessed' | 'transactions.addIdempotent' | 'wallets.saveBalance' | 'ledger.add';

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

describe.each<FailurePoint>(['transactions.addIdempotent', 'wallets.saveBalance', 'ledger.add', 'inbox.markProcessed'])(
  'atomicidade: falha em %s no meio do processamento',
  (point) => {
    test('inbox, transação e ledger não persistem; a reentrega depois processa normalmente', async () => {
      const { wallet, command } = await wagerFor();
      const messageId = `msg-${uuid()}`;
      const boom = new Error(`falha injetada em ${point}`);

      await expect(new ProcessWagerTransactionUseCase(failingAt(point, boom)).execute(command, { consumerName, messageId })).rejects.toBe(boom);

      expect(await inboxRows(messageId)).toHaveLength(0);
      expect((await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [command.externalTransactionId])).rows).toHaveLength(0);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });

      const retried = await useCase.execute(command, { consumerName, messageId });
      expect('idempotentReplay' in retried && retried.idempotentReplay).toBe(false);
      expect(await inboxRows(messageId)).toHaveLength(1);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    });
  },
);

describe('concorrência no inbox', () => {
  test('a mesma mensagem entregue 20 vezes ao mesmo tempo debita uma vez', async () => {
    const { wallet, command } = await wagerFor();
    const messageId = `msg-${uuid()}`;

    // 20 chaves diferentes: o fast-path nunca acerta, então só inbox + lock decidem.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => useCase.execute({ ...command, idempotencyKey: `${command.idempotencyKey}:${i}` }, { consumerName, messageId })),
    );

    expect(results.filter((r) => 'duplicateMessage' in r)).toHaveLength(19);
    expect(results.filter((r) => 'transaction' in r)).toHaveLength(1);
    expect(await inboxRows(messageId)).toHaveLength(1);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });
});
