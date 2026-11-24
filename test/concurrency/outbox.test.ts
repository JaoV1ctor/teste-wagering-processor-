// Cenários #6 e #8 (SPEC §10; README §11), com PROCESSOS reais, Postgres e MiniStack reais.
//  #6: dois publishers na mesma outbox => nenhum evento perdido; duplicata segura e contada.
//  #8: reinício do serviço: commit, o processo morre ANTES de publicar, outro sobe => o evento sai e a consistência final fecha.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID as uuid } from 'node:crypto';
import { createServer } from 'node:net';
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
import { EventSink, expectEventsConsistentWithLedger, outboxOfTransaction, outboxOfWallet, typesOf } from '../support/events';
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
  test('nenhum evento perdido e, sem falhas, nenhum duplicado: claims disjuntos que PULAM a linha travada por outra transação', async () => {
    await parkOutbox(probe);
    const sink = new EventSink(sqs, queues.eventsUrl);
    await sink.collect();
    sink.received.length = 0;
    const { walletIds, eventIds } = await seedEvents(10, 5); // 50 transações => 100 eventos
    expect(eventIds.size).toBe(100);

    // Uma transação alheia segura o evento mais antigo (o primeiro que os dois claims escolheriam) durante toda a publicação.
    // Com FOR UPDATE SKIP LOCKED os publishers a pulam; sem SKIP LOCKED ficariam esperando e estourariam o lock_timeout.
    const holder = await probe.connect();
    let locked: string;
    try {
      await holder.query('begin');
      const { rows } = await holder.query<{ id: string }>('select id from outbox_messages where id = any($1) order by next_attempt_at limit 1 for update', [[...eventIds]]);
      locked = rows[0]?.id ?? '';
      expect(eventIds.has(locked)).toBe(true);

      const a = spawnPublisher({});
      const b = spawnPublisher({});
      await Promise.all([a.ready, b.ready]);
      const [resultA, resultB] = await Promise.all([a.go(), b.go()]); // largam juntas
      expect(resultA).toBeDefined();
      expect(resultB).toBeDefined();
      expect(resultA?.failed).toBe(0);
      expect(resultB?.failed).toBe(0);
      expect((resultA?.published ?? 0) + (resultB?.published ?? 0)).toBe(99); // tudo, menos o que estava travado
    } finally {
      await holder.query('rollback');
      holder.release();
    }

    // Liberada a linha, um terceiro publisher entrega o que sobrou.
    const last = spawnPublisher({});
    await last.ready;
    expect((await last.go())?.published).toBe(1);

    await sink.waitUntil('100 eventos', (s) => s.uniqueIds.size >= 100);
    expect(sink.uniqueIds).toEqual(eventIds); // nenhum perdido, nenhum de fora
    expect(sink.uniqueIds.has(locked)).toBe(true);
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

describe('#8 reinício do serviço', () => {
  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });

  /** O serviço de verdade: `bun run src/main.ts` (HTTP + consumidor + workers + publisher), como em produção. */
  async function startService(pollMs: number): Promise<{ proc: ChildProcess; url: string; stderr: () => string; exited: Promise<void> }> {
    const port = await freePort();
    const proc = spawn(process.execPath, ['run', 'src/main.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env, PORT: String(port), SQS_WAGER_QUEUE_NAME: queues.names.queueName, SQS_WAGER_DLQ_NAME: queues.names.deadLetterQueueName,
        SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName, OUTBOX_POLL_INTERVAL_MS: String(pollMs),
      },
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<void>((resolve) => proc.on('close', () => resolve()));
    const url = `http://localhost:${port}`;
    await waitFor('serviço no ar', async () => {
      if (proc.exitCode !== null) throw new Error(`serviço morreu ao subir: ${stderr.slice(0, 500)}`);
      return fetch(`${url}/wallets/${uuid()}`).then(() => true, () => false);
    }, 30_000);
    return { proc, url, stderr: () => stderr, exited };
  }

  test('commit, SIGKILL antes de publicar, novo serviço sobe => o evento é publicado e wallet == ledger == eventos', async () => {
    await parkOutbox(probe);
    const sink = new EventSink(sqs, queues.eventsUrl);
    await sink.collect();
    sink.received.length = 0;

    // Instância A: o publisher dela só volta a rodar em 1 h; o que ela commita fica no outbox, sem publicar.
    const a = await startService(3_600_000);
    const call = async (base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const playerId = uuid();
    const wallet = await call(a.url, 'POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(wallet.status).toBe(201);
    const walletId = wallet.body.id as string;
    const externalTransactionId = `ext-${uuid()}`;
    const bet = {
      providerId: 'provider-a', externalTransactionId, playerId, walletId, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '30.00', currency: 'BRL' },
    };
    const headers = { 'idempotency-key': `provider-a:${externalTransactionId}`, 'x-correlation-id': 'corr-restart' };
    const first = await call(a.url, 'POST', '/wagering/transactions', bet, headers);
    expect(first.status).toBe(201);

    // Commit feito, nada publicado.
    const before = await outboxOfTransaction(probe, first.body.transactionId);
    expect(typesOf(before)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(before.every((row) => row.published_at === null)).toBe(true);
    await sink.collect();
    expect(sink.received).toEqual([]);

    // O processo morre. Sem SIGTERM, sem shutdown gracioso: SIGKILL.
    a.proc.kill('SIGKILL');
    await a.exited;

    // Outra instância sobe e assume.
    const b = await startService(200);
    try {
      await sink.waitUntil('os 2 eventos publicados pela nova instância', (s) => s.uniqueIds.size >= 2);
      expect(sink.uniqueIds).toEqual(new Set(before.map((row) => row.id)));
      expect(sink.received.every((r) => r.envelope.correlationId === 'corr-restart')).toBe(true);
      await waitFor('published_at gravado', async () => (await outboxOfTransaction(probe, first.body.transactionId)).every((row) => row.published_at !== null));

      // Consistência final: saldo == ledger == eventos; e a idempotência sobreviveu ao reinício (estado só no banco).
      await expectEventsConsistentWithLedger(probe, walletId);
      const replay = await call(b.url, 'POST', '/wagering/transactions', bet, headers);
      expect(replay).toMatchObject({ status: 201, body: { transactionId: first.body.transactionId, idempotentReplay: true } });
      expect(await outboxOfTransaction(probe, first.body.transactionId)).toHaveLength(2); // o replay não gerou evento
      await sink.collect();
      expect(sink.received).toHaveLength(2); // e a fila não recebeu mais nada
    } finally {
      b.proc.kill('SIGKILL');
      await b.exited;
    }
  }, 120_000);
});
