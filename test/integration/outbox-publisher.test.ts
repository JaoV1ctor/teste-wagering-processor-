// Publisher do outbox: claim por lease, publicação na fila `wager-events` REAL (MiniStack), backoff e recuperação.
// O tempo é um relógio injetado: o teste decide quando lease e backoff vencem (nada de sleep). Postgres e SQS reais.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher, Repositories, UnitOfWork } from '../../src/application/ports';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { type PublishOutboxOptions, PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { createProbe, ensureSchema, parkOutbox } from '../support/db';
import { EventSink, expectEventsConsistentWithLedger, outboxOfTransaction, outboxOfWallet, typesOf } from '../support/events';
import { newQueues, type TestQueues } from '../support/sqs';

const probe = createProbe(4);
const sqs = createSqsClient();
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let queues: TestQueues;
let sink: EventSink;
let realPublisher: SqsEventPublisher;
let t = 0; // relógio do publisher
const clock = () => new Date(t);

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
  queues = await newQueues(sqs);
  realPublisher = new SqsEventPublisher(sqs, queues.eventsQueueName);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
  sqs.destroy();
});
beforeEach(async () => {
  await parkOutbox(probe);
  await new EventSink(sqs, queues.eventsUrl).collect(); // esvazia a fila de um teste anterior
  sink = new EventSink(sqs, queues.eventsUrl);
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const rethrow = (error: unknown): never => {
  throw error;
};

function publisherOf(publisher: EventPublisher, unitOfWork: UnitOfWork = uow, extra: Partial<PublishOutboxOptions> = {}): PublishOutboxUseCase {
  return new PublishOutboxUseCase(unitOfWork, publisher, { onError: rethrow, clock, random: () => 0, ...extra });
}

interface Seeded {
  walletId: string;
  transactionIds: string[];
}

/**
 * `bets` apostas de 10,00 numa wallet nova (2 eventos cada: Processed e BalanceChanged). Os eventos da abertura são estacionados: estes testes
 * contam só os eventos das apostas. Depois fixa o relógio do publisher em "agora".
 */
async function seed(bets = 1): Promise<Seeded> {
  const useCase = new ProcessWagerTransactionUseCase(uow);
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('1000.00') });
  await parkOutbox(probe);
  const transactionIds: string[] = [];
  for (let i = 0; i < bets; i += 1) {
    const externalTransactionId = `ext-${uuid()}`;
    const result = await useCase.execute(command(wallet.id, wallet.playerId, externalTransactionId));
    transactionIds.push(result.transaction.id);
  }
  t = Date.now() + 5;
  return { walletId: wallet.id, transactionIds };
}

const command = (walletId: string, playerId: string, externalTransactionId: string): ProcessWagerCommand => ({
  idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId, walletId, roundId: 'r', gameId: 'g',
  kind: WagerTransactionKind.Bet, money: brl('10.00'),
});

const unpublished = async (walletId: string) => (await outboxOfWallet(probe, walletId)).filter((row) => row.published_at === null);

describe('publicação', () => {
  test('publica cada evento na fila padrão com o eventId como identificador e marca published_at', async () => {
    const { walletId, transactionIds } = await seed(1);
    const rows = await outboxOfTransaction(probe, transactionIds[0] ?? '');
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    expect(await publisherOf(realPublisher).runOnce()).toEqual({ claimed: 2, published: 2, failed: 0, abandoned: 0 });

    await sink.waitUntil('2 eventos na fila', (s) => s.received.length >= 2);
    expect(sink.received).toHaveLength(2);
    expect(sink.uniqueIds).toEqual(new Set(rows.map((row) => row.id)));
    for (const { envelope, attributes } of sink.received) {
      expect(attributes).toEqual({ eventId: envelope.eventId, eventType: envelope.eventType });
      const row = rows.find((r) => r.id === envelope.eventId);
      expect(envelope).toEqual(row?.payload as typeof envelope); // o corpo é exatamente o envelope gravado
    }
    expect(await unpublished(walletId)).toEqual([]);
    await expectEventsConsistentWithLedger(probe, walletId);
  });

  test('o que já foi publicado não é publicado de novo', async () => {
    await seed(1);
    const publisher = publisherOf(realPublisher);
    expect(await publisher.runOnce()).toMatchObject({ claimed: 2, published: 2 });
    expect(await publisher.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0, abandoned: 0 });
    await sink.collect();
    expect(sink.received).toHaveLength(2);
  });

  test('o lote respeita batchSize: o resto fica para a próxima passada', async () => {
    const { walletId } = await seed(3); // 6 eventos
    const publisher = publisherOf(realPublisher, uow, { batchSize: 4 });
    expect(await publisher.runOnce()).toMatchObject({ claimed: 4, published: 4 });
    expect(await unpublished(walletId)).toHaveLength(2);
    expect(await publisher.runOnce()).toMatchObject({ claimed: 2, published: 2 });
    expect(await unpublished(walletId)).toHaveLength(0);
  });
});

describe('SQS fora do ar: retry com backoff, sem perder o evento', () => {
  const down = () =>
    new SQSClient({
      endpoint: 'http://127.0.0.1:9', region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' }, maxAttempts: 1,
    });

  test('falha => attempts+1 e next_attempt_at com backoff exponencial; não republica antes da hora; recupera quando o SQS volta', async () => {
    const { walletId } = await seed(1);
    const reported: { eventId: string; attempts: number }[] = [];
    const brokenClient = down();
    const failing = publisherOf(new SqsEventPublisher(brokenClient, queues.eventsQueueName), uow, {
      onError: (_error, context) => reported.push({ eventId: context.eventId, attempts: context.attempts }),
    });

    const t0 = t;
    expect(await failing.runOnce()).toEqual({ claimed: 2, published: 0, failed: 2, abandoned: 0 });
    expect(reported).toHaveLength(2); // nada engolido
    let rows = await outboxOfWallet(probe, walletId);
    expect(rows.map((r) => r.attempts)).toEqual([1, 1]);
    expect(rows.every((r) => r.published_at === null && r.next_attempt_at.getTime() === t0 + 1000)).toBe(true);

    t = t0 + 999; // ainda não venceu
    expect(await failing.runOnce()).toMatchObject({ claimed: 0 });

    t = t0 + 1000; // venceu, mas o SQS continua fora: 2ª falha, espera dobra
    expect(await failing.runOnce()).toMatchObject({ claimed: 2, failed: 2 });
    rows = await outboxOfWallet(probe, walletId);
    expect(rows.map((r) => r.attempts)).toEqual([2, 2]);
    expect(rows.every((r) => r.next_attempt_at.getTime() === t0 + 1000 + 2000)).toBe(true);

    t = t0 + 3000; // o SQS voltou: o evento é publicado, nada se perdeu
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 2, published: 2, failed: 0 });
    await sink.waitUntil('2 eventos na fila', (s) => s.received.length >= 2);
    expect(sink.received).toHaveLength(2);
    expect(await unpublished(walletId)).toEqual([]);
    brokenClient.destroy();
  });

  test('o backoff dobra até o teto de 60 s e o evento continua elegível (nunca é descartado)', async () => {
    const { walletId } = await seed(1);
    const brokenClient = down();
    const failing = publisherOf(new SqsEventPublisher(brokenClient, queues.eventsQueueName), uow, { onError: () => undefined });
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const before = t;
      await failing.runOnce();
      const next = Math.max(...(await outboxOfWallet(probe, walletId)).map((r) => r.next_attempt_at.getTime()));
      delays.push(next - before);
      t = next;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect((await outboxOfWallet(probe, walletId)).every((r) => r.attempts === 9 && r.published_at === null)).toBe(true);
    brokenClient.destroy();
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 2, published: 2 });
  });
});

describe('recuperação por lease', () => {
  test('publisher morre depois do claim: ninguém publica antes do lease vencer; depois outra instância publica, uma vez só', async () => {
    const { walletId } = await seed(1);
    const dead = await uow.run(({ outbox }) => outbox.claimDue(new Date(t), 10, new Date(t + 30_000))); // A reivindicou e morreu
    expect(dead).toHaveLength(2);

    const b = publisherOf(realPublisher);
    t += 29_999;
    expect(await b.runOnce()).toMatchObject({ claimed: 0 }); // lease ainda vale
    t += 2;
    expect(await b.runOnce()).toMatchObject({ claimed: 2, published: 2 });

    await sink.waitUntil('2 eventos na fila', (s) => s.received.length >= 2);
    expect(sink.received).toHaveLength(2);
    expect(sink.duplicates).toBe(0);
    expect(await unpublished(walletId)).toEqual([]);
  });

  test('lote lento: ao vencer o lease o publisher PARA de publicar o resto (outro pode ter reivindicado) e o resto sai na passada seguinte', async () => {
    const { walletId } = await seed(2); // 4 eventos
    const slow: EventPublisher = {
      publish: async (message) => {
        await realPublisher.publish(message);
        t += 20_000; // cada envio "demora" 20 s
      },
    };
    const t0 = t;
    expect(await publisherOf(slow, uow, { leaseMs: 30_000 }).runOnce()).toEqual({ claimed: 4, published: 2, failed: 0, abandoned: 2 });
    expect(await unpublished(walletId)).toHaveLength(2);

    t = Math.max(t, t0 + 30_001);
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 2, published: 2 });
    await sink.waitUntil('4 eventos na fila', (s) => s.received.length >= 4);
    expect(sink.received).toHaveLength(4);
    expect(sink.duplicates).toBe(0);
  });
});

describe('publisher atrasado, com o lease vencido, falha depois de outro reivindicar', () => {
  /** Publisher cujo envio fica pendurado até o teste mandar falhar (a rede travou e estourou o prazo bem depois do lease). */
  function hangingPublisher() {
    let started!: () => void;
    let fail!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const released = new Promise<void>((resolve) => { fail = resolve; });
    const publisher: EventPublisher = {
      publish: async () => {
        started();
        await released;
        throw new Error('envio estourou o prazo');
      },
    };
    return { publisher, sending, fail: () => fail() };
  }

  const schedule = async (walletId: string) =>
    (await outboxOfWallet(probe, walletId)).map((r) => ({ attempts: r.attempts, nextAttemptAt: r.next_attempt_at.getTime() }));

  test('não sobrescreve o lease do segundo: ninguém reivindica o evento enquanto o segundo o tem', async () => {
    const { walletId } = await seed(1);
    const slow = hangingPublisher();
    const first = publisherOf(slow.publisher, uow, { onError: () => undefined }).runOnce();
    await slow.sending;

    t += 30_001; // o lease do 1º venceu
    const secondLease = t + 30_000;
    expect(await uow.run(({ outbox }) => outbox.claimDue(new Date(t), 10, new Date(secondLease)))).toHaveLength(2);
    slow.fail();
    expect(await first).toEqual({ claimed: 2, published: 0, failed: 1, abandoned: 1 });

    expect(await schedule(walletId)).toEqual(Array.from({ length: 2 }, () => ({ attempts: 0, nextAttemptAt: secondLease })));
    t += 29_000; // depois do backoff que o 1º teria agendado, mas dentro do lease do 2º
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 0 });
  });

  test('não desfaz as tentativas nem o backoff que o segundo já gravou', async () => {
    const { walletId } = await seed(1);
    const slow = hangingPublisher();
    const first = publisherOf(slow.publisher, uow, { onError: () => undefined }).runOnce();
    await slow.sending;
    const down: EventPublisher = { publish: async () => { throw new Error('SQS fora'); } };
    const second = publisherOf(down, uow, { onError: () => undefined });

    t += 30_001;
    expect(await second.runOnce()).toMatchObject({ claimed: 2, failed: 2 }); // attempts 1, próxima em 1 s
    t += 1000;
    expect(await second.runOnce()).toMatchObject({ claimed: 2, failed: 2 }); // attempts 2, próxima em 2 s
    const scheduled = await schedule(walletId);
    expect(scheduled.map((s) => s.attempts)).toEqual([2, 2]);
    slow.fail();
    await first;

    expect(await schedule(walletId)).toEqual(scheduled);
  });

  test('sem ninguém ter reivindicado, a falha tardia ainda agenda o retry normalmente', async () => {
    const { walletId } = await seed(1);
    const slow = hangingPublisher();
    const first = publisherOf(slow.publisher, uow, { onError: () => undefined }).runOnce();
    await slow.sending;

    t += 30_001;
    slow.fail();
    await first;

    expect((await schedule(walletId)).map((s) => s.attempts).sort()).toEqual([0, 1]);
    expect((await schedule(walletId)).find((s) => s.attempts === 1)?.nextAttemptAt).toBe(t + 1000);
  });
});

describe('duplicata de publicação é segura e contada', () => {
  test('publicou mas não conseguiu marcar (crash entre o envio e o UPDATE): depois do lease sai de novo com o MESMO eventId', async () => {
    const { walletId, transactionIds } = await seed(1);
    const failMark: UnitOfWork = {
      read: (work) => uow.read(work),
      run: (work) =>
        uow.run((repos: Repositories) => {
          const outbox = Object.assign(Object.create(repos.outbox), {
            markPublished: async () => {
              throw new Error('falha injetada depois de publicar');
            },
          });
          return work({ ...repos, outbox });
        }),
    };
    const errors: unknown[] = [];
    const first = publisherOf(realPublisher, failMark, { onError: (error) => errors.push(error) });
    expect(await first.runOnce()).toMatchObject({ claimed: 2, published: 0, failed: 2 });
    expect(errors).toHaveLength(2);
    expect(await unpublished(walletId)).toHaveLength(2); // a fila já tem as mensagens, o banco ainda não sabe

    t += 30_001;
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 2, published: 2 });

    await sink.waitUntil('4 mensagens na fila', (s) => s.received.length >= 4);
    const ids = new Set((await outboxOfTransaction(probe, transactionIds[0] ?? '')).map((r) => r.id));
    expect(sink.received).toHaveLength(4);
    expect(sink.uniqueIds).toEqual(ids); // nenhum evento perdido...
    expect(sink.duplicates).toBe(2); // ...e as repetições são contadas, não escondidas
    expect(await unpublished(walletId)).toEqual([]);
    await expectEventsConsistentWithLedger(probe, walletId);
  });
});

describe('um evento NUNCA é publicado antes do COMMIT', () => {
  /** UnitOfWork real cuja transação, depois de inserir o 2º evento, fica ABERTA até o teste liberar (commit) ou falhar (rollback). */
  function holdingBeforeCommit() {
    let reached!: () => void;
    let release!: (error?: Error) => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve, reject) => { release = (error) => (error ? reject(error) : resolve()); });
    const holder: UnitOfWork = {
      read: (work) => uow.read(work),
      run: (work) =>
        uow.run((repos: Repositories) => {
          let added = 0;
          const outbox = Object.assign(Object.create(repos.outbox), {
            add: async (message: Parameters<Repositories['outbox']['add']>[0]) => {
              await repos.outbox.add(message);
              added += 1;
              if (added === 2) {
                reached();
                await releasePromise;
              }
            },
          });
          return work({ ...repos, outbox });
        }),
    };
    return { holder, reached: reachedPromise, release };
  }

  test('com a transação aberta (eventos já INSERIDOS, sem commit) o publisher não vê nada e a fila fica vazia; após o commit, publica', async () => {
    const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('1000.00') });
    await parkOutbox(probe); // os eventos da abertura não fazem parte do que este teste observa
    const { holder, reached, release } = holdingBeforeCommit();
    const inFlight = new ProcessWagerTransactionUseCase(holder).execute(command(wallet.id, wallet.playerId, `ext-${uuid()}`));
    await reached;
    t = Date.now() + 5;

    expect(await publisherOf(realPublisher).runOnce()).toEqual({ claimed: 0, published: 0, failed: 0, abandoned: 0 });
    await sink.collect();
    expect(sink.received).toEqual([]);

    release();
    const { transaction } = await inFlight;
    t = Date.now() + 5;
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 2, published: 2 });
    await sink.waitUntil('2 eventos na fila', (s) => s.received.length >= 2);
    expect(new Set(sink.received.map((r) => r.envelope.data['transactionId']))).toEqual(new Set([transaction.id]));
  });

  test('transação que falha (ROLLBACK): nenhum evento existe e nenhuma mensagem chega à fila, nunca', async () => {
    const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl('1000.00') });
    await parkOutbox(probe); // os eventos da abertura não fazem parte do que este teste observa
    const { holder, reached, release } = holdingBeforeCommit();
    const inFlight = new ProcessWagerTransactionUseCase(holder).execute(command(wallet.id, wallet.playerId, `ext-${uuid()}`));
    // Não usar `expect(inFlight).rejects` aqui: o Bun gira o event loop até a promise resolver, e só este teste a libera.
    const outcome = inFlight.then(() => undefined, (error: unknown) => error);
    await reached;

    t = Date.now() + 5;
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 0 }); // durante a transação aberta
    release(new Error('abortada pelo teste'));
    expect(await outcome).toMatchObject({ message: 'abortada pelo teste' });

    t = Date.now() + 5;
    expect(await publisherOf(realPublisher).runOnce()).toMatchObject({ claimed: 0 }); // depois do rollback
    await sink.collect();
    expect(sink.received).toEqual([]);
    expect(await outboxOfWallet(probe, wallet.id)).toEqual([]);
  });
});
