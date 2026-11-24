// Cenário #6 (SPEC §10; README §11), com PROCESSOS reais, Postgres e MiniStack reais:
// dois publishers na mesma outbox => nenhum evento perdido; duplicata segura e contada.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import type { PublishSummary } from '../../src/application/publish-outbox.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, parkOutbox } from '../support/db';
import { EventSink, expectEventsConsistentWithLedger, outboxOfWallet } from '../support/events';
import { newQueues, type TestQueues, waitFor } from '../support/sqs';

const probe = createProbe(4);
const sqs = createSqsClient();
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let queues: TestQueues;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
  queues = await newQueues(sqs);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
  sqs.destroy();
});

const brl = (v: string) => Money.fromString(v, 'BRL');

interface Child {
  proc: ChildProcess;
  ready: Promise<void>;
  /** Libera o filho; o resultado é `undefined` se ele morreu antes de imprimir `RESULT:`. */
  go(): Promise<PublishSummary | undefined>;
}

function spawnPublisher(env: Record<string, string>): Child {
  const proc = spawn(process.execPath, ['run', 'test/support/outbox-publisher-child.ts'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName, ...env },
  });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<void>((resolve) => proc.on('close', () => resolve()));
  const ready = waitFor('filho pronto', () => stdout.includes('READY') || stderr.length > 0, 30_000).then(() => {
    if (!stdout.includes('READY')) throw new Error(`filho não subiu: ${stderr.slice(0, 500)}`);
  });
  return {
    proc,
    ready,
    async go() {
      proc.stdin?.write('GO\n');
      await closed;
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
      return line === undefined ? undefined : (JSON.parse(line.slice('RESULT:'.length)) as PublishSummary);
    },
  };
}

/** `perWallet` apostas em cada uma de `wallets` wallets, em paralelo entre wallets. Devolve os ids dos eventos gerados. */
async function seedEvents(wallets: number, perWallet: number): Promise<{ walletIds: string[]; eventIds: Set<string> }> {
  const useCase = new ProcessWagerTransactionUseCase(uow);
  const walletIds = await Promise.all(
    Array.from({ length: wallets }, async () => {
      const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('1000.00') });
      for (let i = 0; i < perWallet; i += 1) {
        const externalTransactionId = `ext-${uuid()}`;
        await useCase.execute({
          idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
          walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl('10.00'),
        });
      }
      return wallet.id;
    }),
  );
  const eventIds = new Set((await Promise.all(walletIds.map((id) => outboxOfWallet(probe, id)))).flat().map((row) => row.id));
  return { walletIds, eventIds };
}

const countUnpublished = async (walletIds: string[]): Promise<number> =>
  (await Promise.all(walletIds.map((id) => outboxOfWallet(probe, id)))).flat().filter((row) => row.published_at === null).length;

describe('#6 dois publishers concorrentes na mesma outbox', () => {
  test('nenhum evento perdido e, sem falhas, nenhum duplicado: os claims são disjuntos', async () => {
    await parkOutbox(probe);
    const sink = new EventSink(sqs, queues.eventsUrl);
    await sink.collect();
    sink.received.length = 0;
    const { walletIds, eventIds } = await seedEvents(10, 5); // 50 transações => 100 eventos
    expect(eventIds.size).toBe(100);

    const a = spawnPublisher({});
    const b = spawnPublisher({});
    await Promise.all([a.ready, b.ready]);
    const [resultA, resultB] = await Promise.all([a.go(), b.go()]); // largam juntas

    expect(resultA).toBeDefined();
    expect(resultB).toBeDefined();
    const published = (resultA?.published ?? 0) + (resultB?.published ?? 0);
    expect(published).toBe(100); // soma dos dois publishers == total: ninguém ficou sem
    expect(resultA?.failed).toBe(0);
    expect(resultB?.failed).toBe(0);

    await sink.waitUntil('100 eventos', (s) => s.uniqueIds.size >= 100);
    expect(sink.uniqueIds).toEqual(eventIds); // nenhum perdido, nenhum de fora
    expect(sink.duplicates).toBe(0);
    expect(await countUnpublished(walletIds)).toBe(0);
    for (const walletId of walletIds) await expectEventsConsistentWithLedger(probe, walletId);
  }, 90_000);

  test('publisher morre (SIGKILL) depois de enviar e antes de marcar: outro publica de novo depois do lease; sem perda, duplicata contada e idêntica por eventId', async () => {
    await parkOutbox(probe);
    const sink = new EventSink(sqs, queues.eventsUrl);
    await sink.collect();
    sink.received.length = 0;
    const { walletIds, eventIds } = await seedEvents(4, 5); // 40 eventos

    const dying = spawnPublisher({ DIE_AFTER_PUBLISHES: '3', OUTBOX_BATCH_SIZE: '7' });
    await dying.ready;
    expect(await dying.go()).toBeUndefined(); // morreu sem imprimir resultado
    expect(await countUnpublished(walletIds)).toBe(40 - 2); // 2 marcados; o 3º foi ENVIADO mas não marcado; o lote inteiro está sob lease

    // Outro publisher, com o relógio além do lease do que morreu (sem esperar 30 s de parede).
    const survivor = spawnPublisher({ CLOCK_OFFSET_MS: '60000' });
    await survivor.ready;
    const result = await survivor.go();
    expect(result?.published).toBe(40 - 2);

    await sink.waitUntil('todos os eventos', (s) => s.uniqueIds.size >= 40 && s.received.length >= 41);
    expect(sink.uniqueIds).toEqual(eventIds); // nada perdido
    expect(sink.duplicates).toBe(1); // exatamente o evento enviado e não marcado: o consumidor o deduplica pelo eventId
    expect(await countUnpublished(walletIds)).toBe(0);
    for (const walletId of walletIds) await expectEventsConsistentWithLedger(probe, walletId);
  }, 90_000);
});
