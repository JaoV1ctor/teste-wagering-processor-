// Precedência dentro do grupo (wallet) quando a mensagem da frente não sai da fila. Postgres REAL e MiniStack REAL: a falha é injetada
// pelas portas do consumidor (MessageQueue, handler e processor), sem nada no código de produção.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../src/application/errors';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { Money } from '../../src/domain/money';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { type MessageHandler, QueueConsumer } from '../../src/interface/sqs/queue-consumer';
import { WAGER_CONSUMER_NAME, WagerMessageHandler } from '../../src/interface/sqs/wager-message-handler';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import {
  createTestConsumer, InterceptingQueue, isQueueEmpty, newQueues, peek, type QueueInterceptors, RecordingProcessor, sendRaw, sendWager,
  type TestQueues, type TestWallet, waitFor,
} from '../support/sqs';

const probe = createProbe(4);
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let client: SQSClient;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
  client = createSqsClient();
});
afterAll(async () => {
  await probe.end();
  await orm.close();
  client.destroy();
});

const newWallet = async (balance: string): Promise<TestWallet> => {
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: Money.fromString(balance, 'BRL') });
  return { id: wallet.id, playerId: wallet.playerId };
};

const ledgerLines = async (walletId: string) =>
  (await probe.query<{ line: string }>(
    "select direction || ':' || balance_after::text as line from wallet_ledger_entries where wallet_id = $1 order by seq", [walletId],
  )).rows.map((row) => row.line);

const statusOf = async (externalTransactionId: string) =>
  (await probe.query<{ status: string }>('select status from wager_transactions where external_transaction_id = $1', [externalTransactionId])).rows[0]?.status;

/** `messageId` do corpo; um corpo que não é JSON (mensagem inválida de propósito) identifica a si mesmo. */
const messageIdOf = (body: string): string => (body.startsWith('{') ? (JSON.parse(body) as { messageId: string }).messageId : body);

/** WIN 100,00 e depois BET 80,00 sobre saldo zero: fora de ordem a BET é rejeitada por saldo insuficiente. */
async function winThenBet(queues: TestQueues) {
  const wallet = await newWallet('0.00');
  const win = await sendWager(client, queues, wallet, { kind: 'WIN', amount: '100.00' });
  const bet = await sendWager(client, queues, wallet, { kind: 'BET', amount: '80.00' });
  return { wallet, win, bet };
}

/** Fila real que anota, em ordem, o tamanho de cada lote, as devoluções e os acks. */
function observedQueue(queues: TestQueues, interceptors: QueueInterceptors = {}) {
  const batches: string[][] = [];
  const visibility: { messageId: string; seconds: number }[] = [];
  const acknowledged: string[] = [];
  const queue = new InterceptingQueue(new SqsMessageQueue(client, queues.names), {
    ...interceptors,
    onReceive: async (next) => {
      const messages = await next();
      if (messages.length > 0) batches.push(messages.map((m) => messageIdOf(m.body)));
      return messages;
    },
    onChangeVisibility: async (message, seconds, next) => {
      await (interceptors.onChangeVisibility ? interceptors.onChangeVisibility(message, seconds, next) : next());
      visibility.push({ messageId: messageIdOf(message.body), seconds });
    },
    onAcknowledge: async (message, next) => {
      await (interceptors.onAcknowledge ? interceptors.onAcknowledge(message, next) : next());
      acknowledged.push(messageIdOf(message.body));
    },
  });
  return { queue, batches, visibility, acknowledged };
}

async function runUntilEmpty(consumer: QueueConsumer, queues: TestQueues, timeoutMs = 30_000): Promise<void> {
  consumer.start();
  try {
    await waitFor('fila principal vazia', () => isQueueEmpty(client, queues.mainUrl), timeoutMs);
  } finally {
    await consumer.stop();
  }
}

/** Processor real que falha de forma transitória nas primeiras `times` tentativas das mensagens indicadas; anota todas as tentativas. */
function flakyProcessor(failing: string, times = 1, beforeFailure: () => Promise<void> = async () => undefined) {
  const attempts: string[] = [];
  let failures = 0;
  const processor = new RecordingProcessor(uow, async (command) => {
    attempts.push(command.correlationId ?? '');
    if (command.correlationId === failing && failures < times) {
      failures += 1;
      await beforeFailure();
      throw new TransientInfrastructureError(new Error('falha transitória injetada pelo teste'));
    }
  });
  return { processor, attempts };
}

describe('a mensagem da frente é adiada: as seguintes do grupo, já recebidas, não começam', () => {
  test.each([0, 2])('WIN falha uma vez (adiada %d s) e a BET do mesmo lote espera: o resultado é o da ordem de envio', async (delaySeconds) => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const { processor, attempts } = flakyProcessor(win.messageId);
    const { queue, batches, visibility } = observedQueue(queues);
    const { consumer } = createTestConsumer({ queue, processor, backoff: { baseSeconds: delaySeconds, maxSeconds: delaySeconds }, random: () => 1 });

    await runUntilEmpty(consumer, queues);

    expect(batches[0]).toEqual([win.messageId, bet.messageId]); // pré-condição: as duas vieram no mesmo lote
    expect(attempts).toEqual([win.messageId, win.messageId, bet.messageId]);
    expect(visibility).toEqual([{ messageId: win.messageId, seconds: delaySeconds }, { messageId: bet.messageId, seconds: 0 }]);
    expect(await statusOf(bet.data.externalTransactionId)).toBe('PROCESSED');
    expect(await ledgerLines(wallet.id)).toEqual(['CREDIT:100.00', 'DEBIT:20.00']);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '20.00', rebuilt: '20.00', entries: 2 });
    expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
  });

  test('três do mesmo grupo: as duas seguintes voltam na ordem e são aplicadas na ordem de envio', async () => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const last = await sendWager(client, queues, wallet, { kind: 'BET', amount: '20.00' });
    const { processor, attempts } = flakyProcessor(win.messageId);
    const { queue, visibility } = observedQueue(queues);
    const { consumer } = createTestConsumer({ queue, processor, backoff: { baseSeconds: 1, maxSeconds: 1 }, random: () => 1 });

    await runUntilEmpty(consumer, queues);

    expect(attempts).toEqual([win.messageId, win.messageId, bet.messageId, last.messageId]);
    expect(visibility.map((v) => v.messageId)).toEqual([win.messageId, bet.messageId, last.messageId]);
    expect(await ledgerLines(wallet.id)).toEqual(['CREDIT:100.00', 'DEBIT:20.00', 'DEBIT:0.00']);
  });

  test('outros grupos seguem em paralelo enquanto um está parado, e não são devolvidos', async () => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const other = await newWallet('100.00');
    const others = [
      await sendWager(client, queues, other, { amount: '10.00' }),
      await sendWager(client, queues, other, { amount: '10.00' }),
    ].map((m) => m.messageId);
    // A WIN só falha DEPOIS que o outro grupo terminou: se o consumidor fosse sequencial entre grupos, o teste estouraria o prazo.
    const { processor, attempts } = flakyProcessor(win.messageId, 1, () =>
      waitFor('o outro grupo terminar com a WIN ainda em andamento', async () => (await ledgerBalance(probe, other.id)).stored === '80.00'),
    );
    const { queue, visibility } = observedQueue(queues);
    const { consumer } = createTestConsumer({ queue, processor, backoff: { baseSeconds: 2, maxSeconds: 2 }, random: () => 1 });

    await runUntilEmpty(consumer, queues);

    expect(attempts.filter((id) => others.includes(id))).toEqual(others);
    expect(attempts.indexOf(others[1] ?? '')).toBeLessThan(attempts.lastIndexOf(win.messageId));
    expect(visibility.map((v) => v.messageId)).toEqual([win.messageId, bet.messageId]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '20.00', rebuilt: '20.00', entries: 2 });
    expect(await ledgerBalance(probe, other.id)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 3 });
  });
});

describe('qualquer falha que deixe a mensagem da frente na fila também segura o grupo', () => {
  test('o ack falha depois do commit: a seguinte só começa depois de a primeira ser confirmada', async () => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const { processor, attempts } = flakyProcessor('nenhuma');
    let failed = false;
    const { queue, acknowledged } = observedQueue(queues, {
      onAcknowledge: async (_message, next) => {
        if (!failed) {
          failed = true;
          throw new Error('DeleteMessage falhou');
        }
        await next();
      },
    });
    const { consumer } = createTestConsumer({ queue, processor, consume: { visibilityTimeoutSeconds: 2 } });

    await runUntilEmpty(consumer, queues);

    expect(attempts).toEqual([win.messageId, win.messageId, bet.messageId]);
    expect(acknowledged).toEqual([win.messageId, bet.messageId]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '20.00', rebuilt: '20.00', entries: 2 });
  });

  test('o ChangeMessageVisibility do adiamento falha: a seguinte espera a primeira voltar', async () => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const { processor, attempts } = flakyProcessor(win.messageId);
    let failed = false;
    const { queue } = observedQueue(queues, {
      onChangeVisibility: async (_message, _seconds, next) => {
        if (!failed) {
          failed = true;
          throw new Error('ChangeMessageVisibility falhou');
        }
        await next();
      },
    });
    const { consumer } = createTestConsumer({ queue, processor, consume: { visibilityTimeoutSeconds: 2 } });

    await runUntilEmpty(consumer, queues);

    expect(attempts).toEqual([win.messageId, win.messageId, bet.messageId]);
    expect(await ledgerLines(wallet.id)).toEqual(['CREDIT:100.00', 'DEBIT:20.00']);
  });

  test('o handler lança (bug): a seguinte não começa antes de a primeira ser reentregue e confirmada', async () => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const { processor, attempts } = flakyProcessor('nenhuma');
    const log = () => undefined;
    const real = new WagerMessageHandler(processor, { consumerName: WAGER_CONSUMER_NAME, backoff: { baseSeconds: 0, maxSeconds: 0 }, log });
    const seen: string[] = [];
    const handler: MessageHandler = {
      handle: async (body, receiveCount) => {
        seen.push(messageIdOf(body));
        if (seen.length === 1) throw new Error('bug no handler');
        return real.handle(body, receiveCount);
      },
    };
    const consumer = new QueueConsumer(new SqsMessageQueue(client, queues.names), handler, {
      concurrency: 5, batchSize: 10, waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, shutdownTimeoutMs: 2000, receiveErrorPauseMs: 100, log,
    });

    await runUntilEmpty(consumer, queues);

    expect(seen).toEqual([win.messageId, win.messageId, bet.messageId]);
    expect(attempts).toEqual([win.messageId, bet.messageId]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '20.00', rebuilt: '20.00', entries: 2 });
  });

  test('o envio à DLQ falha: a seguinte espera a primeira chegar à DLQ', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('100.00');
    await sendRaw(client, queues.mainUrl, 'corpo-invalido', { groupId: wallet.id });
    const bet = await sendWager(client, queues, wallet, { amount: '10.00' });
    const { processor, attempts } = flakyProcessor('nenhuma');
    const steps: string[] = [];
    let failed = false;
    const queue = new InterceptingQueue(new SqsMessageQueue(client, queues.names), {
      onDeadLetter: async (_message, _reason, next) => {
        if (!failed) {
          failed = true;
          steps.push('dlq-falhou');
          throw new Error('SendMessage à DLQ falhou');
        }
        await next();
        steps.push('dlq-ok');
      },
    });
    const observed = { execute: async (...args: Parameters<RecordingProcessor['execute']>) => { steps.push('bet'); return processor.execute(...args); } };
    const { consumer } = createTestConsumer({ queue, processor: observed, consume: { visibilityTimeoutSeconds: 2 } });

    await runUntilEmpty(consumer, queues);

    expect(steps).toEqual(['dlq-falhou', 'dlq-ok', 'bet']);
    expect(attempts).toEqual([bet.messageId]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
  });
});

describe('quando o grupo pode seguir', () => {
  test('falha permanente já na DLQ não segura o grupo: a seguinte é processada no mesmo lote, sem devolução', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('100.00');
    await sendRaw(client, queues.mainUrl, 'corpo-invalido', { groupId: wallet.id });
    const bet = await sendWager(client, queues, wallet, { amount: '10.00' });
    const { queue, batches, visibility, acknowledged } = observedQueue(queues);
    const { consumer } = createTestConsumer({ queue, processor: new RecordingProcessor(uow) });

    await runUntilEmpty(consumer, queues);

    expect(batches).toEqual([['corpo-invalido', bet.messageId]]);
    expect(acknowledged).toEqual(['corpo-invalido', bet.messageId]);
    expect(visibility).toEqual([]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
    expect(await peek(client, queues.dlqUrl)).toHaveLength(1);
  });
});

describe('limite: as seguintes gastam recebimentos junto com a primeira', () => {
  test('a primeira falha nos 5 recebimentos: ela e a seguinte vão à DLQ, na ordem, sem a seguinte ter sido processada', async () => {
    const queues = await newQueues(client);
    const { wallet, win, bet } = await winThenBet(queues);
    const { processor, attempts } = flakyProcessor(win.messageId, 99);
    const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor });
    let inDlq: string[] = [];

    consumer.start();
    try {
      await waitFor('as duas na DLQ', async () => {
        inDlq = (await peek(client, queues.dlqUrl)).map((message) => messageIdOf(message.Body ?? ''));
        return inDlq.length >= 2;
      }, 30_000);
    } finally {
      await consumer.stop();
    }

    expect(inDlq).toEqual([win.messageId, bet.messageId]);
    expect(attempts).toEqual(Array.from({ length: 5 }, () => win.messageId));
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '0.00', rebuilt: '0', entries: 0 });
  }, 40_000);
});
