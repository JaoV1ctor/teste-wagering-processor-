// Consumidor SQS (docs/ARCHITECTURE.md, "Fluxo de uma mensagem"): Postgres REAL e MiniStack REAL. Os dublês só OBSERVAM a fila ou interceptam uma chamada (a fila por baixo é real).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import type { UnitOfWork } from '../../src/application/ports';
import { Money } from '../../src/domain/money';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import type { QueueConsumer } from '../../src/interface/sqs/queue-consumer';
import { WAGER_CONSUMER_NAME } from '../../src/interface/sqs/wager-message-handler';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import {
  createTestConsumer, InterceptingQueue, isQueueEmpty, newQueues, peek, RecordingProcessor, sendRaw, sendWager, type TestQueues, type TestWallet,
  type QueueInterceptors, waitFor,
} from '../support/sqs';

const probe = createProbe(6);
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

const brl = (v: string) => Money.fromString(v, 'BRL');
const newWallet = async (balance = '100.00'): Promise<TestWallet> => {
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl(balance) });
  return { id: wallet.id, playerId: wallet.playerId };
};

/** Fila real + consumidor real; `stop()` sempre roda, mesmo se o teste falhar. */
async function withConsumer<T>(
  setup: { queues: TestQueues; unitOfWork?: UnitOfWork; interceptors?: QueueInterceptors; processor?: RecordingProcessor; consume?: Parameters<typeof createTestConsumer>[0]['consume']; backoff?: { baseSeconds: number; maxSeconds: number }; random?: () => number },
  body: (ctx: { consumer: QueueConsumer; processor: RecordingProcessor; logs: ReturnType<typeof createTestConsumer>['logs'] }) => Promise<T>,
): Promise<T> {
  const queue = new InterceptingQueue(new SqsMessageQueue(client, setup.queues.names), setup.interceptors);
  const processor = setup.processor ?? new RecordingProcessor(setup.unitOfWork ?? uow);
  const { consumer, logs } = createTestConsumer({
    queue, processor, ...(setup.consume ? { consume: setup.consume } : {}), ...(setup.backoff ? { backoff: setup.backoff } : {}),
    ...(setup.random ? { random: setup.random } : {}),
  });
  consumer.start();
  try {
    return await body({ consumer, processor, logs });
  } finally {
    await consumer.stop();
  }
}

const transactionRows = async (externalTransactionId: string) =>
  (await probe.query<{ status: string; failure_code: string | null }>(
    'select status, failure_code from wager_transactions where external_transaction_id = $1', [externalTransactionId],
  )).rows;
const inboxRows = async (messageId: string) =>
  (await probe.query('select 1 from inbox_messages where consumer_name = $1 and message_id = $2', [WAGER_CONSUMER_NAME, messageId])).rows;

describe('consumo básico', () => {
  test('BET: debita uma vez, grava transação, ledger e inbox, e apaga a mensagem da fila', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    await withConsumer({ queues }, async () => {
      const message = await sendWager(client, queues, wallet, { amount: '25.00' });

      await waitFor('fila vazia (ack feito)', () => isQueueEmpty(client, queues.mainUrl));

      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
      expect(await transactionRows(message.data.externalTransactionId)).toEqual([{ status: WagerTransactionStatus.Processed, failure_code: null }]);
      expect(await inboxRows(message.messageId)).toHaveLength(1);
      expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
    });
  });

  test('ack SOMENTE depois do commit: no instante do ack a transação já está gravada', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    const committedAtAck: boolean[] = [];
    const interceptors: QueueInterceptors = {
      onAcknowledge: async (message, next) => {
        const externalTransactionId = JSON.parse(message.body).data.externalTransactionId as string;
        committedAtAck.push((await transactionRows(externalTransactionId)).length === 1);
        await next();
      },
    };
    await withConsumer({ queues, interceptors }, async () => {
      await sendWager(client, queues, wallet);
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));
    });
    expect(committedAtAck).toEqual([true]);
  });

  test('BET sem saldo: REJECTED é resultado de negócio gravado e a mensagem é confirmada (não vai à DLQ)', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('10.00');
    await withConsumer({ queues }, async () => {
      const message = await sendWager(client, queues, wallet, { amount: '50.00' });

      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));

      expect(await transactionRows(message.data.externalTransactionId)).toEqual([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' }]);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 1 });
      expect(await inboxRows(message.messageId)).toHaveLength(1);
      expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
    });
  });
});

describe('duplicação e redelivery', () => {
  test('mesma messageId entregue duas vezes com o mesmo corpo: um débito, a 2ª é duplicata do inbox', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    await withConsumer({ queues }, async ({ processor }) => {
      const message = await sendWager(client, queues, wallet, { amount: '25.00' });
      // Outro MessageDeduplicationId: o SQS não barra, então chegam duas entregas da mesma messageId (produtor que reenviou fora da janela de 5 min).
      await sendRaw(client, queues.mainUrl, JSON.stringify(message), { groupId: wallet.id });

      await waitFor('as duas entregas processadas', () => processor.outcomes.length === 2);
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));

      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
      expect(await transactionRows(message.data.externalTransactionId)).toHaveLength(1);
      expect(processor.outcomes[0]).toMatchObject({ idempotentReplay: false });
      expect(processor.outcomes[1]).toEqual({ duplicateMessage: true });
    });
  });

  test('mesma messageId com OUTRA idempotencyKey e o mesmo conteúdo: o inbox barra (duplicateMessage) e nada é debitado de novo', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    await withConsumer({ queues }, async ({ processor }) => {
      const message = await sendWager(client, queues, wallet, { amount: '25.00' });
      const sameMessageOtherKey = { ...message, data: { ...message.data, idempotencyKey: `${message.data.idempotencyKey}:reenvio` } };
      await sendRaw(client, queues.mainUrl, JSON.stringify(sameMessageOtherKey), { groupId: wallet.id });

      await waitFor('as duas entregas processadas', () => processor.outcomes.length === 2);
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));

      expect(processor.outcomes[1]).toEqual({ duplicateMessage: true });
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
      expect(await transactionRows(message.data.externalTransactionId)).toHaveLength(1);
      expect(await inboxRows(message.messageId)).toHaveLength(1);
    });
  });

  test('redelivery com messageId NOVA e a mesma idempotencyKey: replay pela idempotência, um débito', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    await withConsumer({ queues }, async ({ processor }) => {
      const first = await sendWager(client, queues, wallet, { amount: '25.00' });
      await sendWager(client, queues, wallet, {
        amount: '25.00', externalTransactionId: first.data.externalTransactionId, idempotencyKey: first.data.idempotencyKey,
      });

      await waitFor('as duas entregas processadas', () => processor.outcomes.length === 2);
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));

      expect(processor.outcomes.map((o) => ('idempotentReplay' in o ? o.idempotentReplay : 'outro'))).toEqual([false, true]);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    });
  });

  test('ordem por wallet: mensagens da mesma wallet são aplicadas na ordem de envio (ledger na mesma sequência)', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('10.00');
    // A ordem importa: BET 5.00 só passa depois do WIN 5.00; a BET 1.00 sem saldo é rejeitada; fora de ordem o resultado seria outro.
    const steps = [
      { kind: 'BET', amount: '10.00' }, { kind: 'WIN', amount: '5.00' }, { kind: 'BET', amount: '5.00' },
      { kind: 'BET', amount: '1.00' }, { kind: 'WIN', amount: '20.00' }, { kind: 'BET', amount: '20.00' },
    ] as const;
    const sent: string[] = [];
    for (const step of steps) sent.push((await sendWager(client, queues, wallet, step)).data.externalTransactionId);

    await withConsumer({ queues }, async () => {
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));

      const { rows: ledger } = await probe.query<{ direction: string; balance_after: string }>(
        'select direction, balance_after::text from wallet_ledger_entries where wallet_id = $1 order by seq', [wallet.id],
      );
      expect(ledger.map((l) => `${l.direction}:${l.balance_after}`)).toEqual([
        'CREDIT:10.00', 'DEBIT:0.00', 'CREDIT:5.00', 'DEBIT:0.00', 'CREDIT:20.00', 'DEBIT:0.00',
      ]);
      const statuses = await Promise.all(sent.map(async (id) => (await transactionRows(id))[0]?.status));
      expect(statuses).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED', 'REJECTED', 'PROCESSED', 'PROCESSED']);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '0.00', rebuilt: '0.00', entries: 6 });
    });
  });
});

describe('erros permanentes: DLQ explícita e só então ack', () => {
  const wallet0 = { providerId: 'provider-a', roundId: 'r', gameId: 'g' };
  const valid = (walletId: string, playerId: string, overrides: Record<string, unknown> = {}) => ({
    messageId: `msg-${uuid()}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: {
      ...wallet0, externalTransactionId: `ext-${uuid()}`, idempotencyKey: `k-${uuid()}`, playerId, walletId, kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' }, ...overrides,
    },
  });

  test.each([
    ['corpo que não é JSON', () => 'isto não é json', 'MALFORMED_MESSAGE'],
    ['type desconhecido', () => JSON.stringify({ ...valid(uuid(), uuid()), type: 'OutroEvento' }), 'UNKNOWN_MESSAGE_TYPE'],
    ['campo obrigatório ausente', () => JSON.stringify({ messageId: 'm', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { providerId: 'p' } }), 'MALFORMED_MESSAGE'],
    ['valor com 3 casas decimais', () => JSON.stringify(valid(uuid(), uuid(), { money: { amount: '10.005', currency: 'BRL' } })), 'MALFORMED_MESSAGE'],
    ['wallet inexistente (nada foi gravado, o ack silencioso perderia a mensagem)', () => JSON.stringify(valid(uuid(), uuid())), 'WALLET_NOT_FOUND'],
  ])('%s => DLQ com MessageGroupId e MessageDeduplicationId, e depois ack', async (_name, makeBody, reason) => {
    const queues = await newQueues(client);
    const groupId = `group-${uuid()}`;
    const calls: string[] = [];
    const interceptors: QueueInterceptors = {
      onDeadLetter: async (_m, r, next) => { calls.push(`deadLetter:${r}`); await next(); },
      onAcknowledge: async (_m, next) => { calls.push('acknowledge'); await next(); },
    };
    await withConsumer({ queues, interceptors }, async () => {
      const body = makeBody();
      await sendRaw(client, queues.mainUrl, body, { groupId });

      await waitFor('mensagem na DLQ', async () => (await peek(client, queues.dlqUrl)).length > 0);
      await waitFor('fila principal vazia (ack feito)', () => isQueueEmpty(client, queues.mainUrl));

      const [inDlq] = await peek(client, queues.dlqUrl);
      expect(inDlq?.Body).toBe(body);
      expect(inDlq?.Attributes?.['MessageGroupId']).toBe(groupId);
      expect(inDlq?.Attributes?.['MessageDeduplicationId']).toBeTruthy();
      expect(inDlq?.MessageAttributes?.['FailureReason']?.StringValue).toBe(reason);
      expect(calls).toEqual([`deadLetter:${reason}`, 'acknowledge']);
    });
  });

  test('messageId reutilizada com outro conteúdo => permanente (INBOX_PAYLOAD_CONFLICT) e nada novo é gravado', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    await withConsumer({ queues }, async ({ processor }) => {
      const first = await sendWager(client, queues, wallet, { amount: '25.00' });
      await waitFor('1ª processada', () => processor.outcomes.length === 1);
      const conflicting = {
        ...first, data: { ...first.data, money: { amount: '99.00', currency: 'BRL' }, externalTransactionId: `ext-${uuid()}`, idempotencyKey: `k-${uuid()}` },
      };
      await sendRaw(client, queues.mainUrl, JSON.stringify(conflicting), { groupId: wallet.id });

      await waitFor('mensagem na DLQ', async () => (await peek(client, queues.dlqUrl)).length > 0);

      const [inDlq] = await peek(client, queues.dlqUrl);
      expect(inDlq?.MessageAttributes?.['FailureReason']?.StringValue).toBe('INBOX_PAYLOAD_CONFLICT');
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
      expect(await transactionRows(conflicting.data.externalTransactionId)).toHaveLength(0);
    });
  });

  test('mesma idempotencyKey com outro payload => permanente (IDEMPOTENCY_CONFLICT): sem resposta a quem enviou, a DLQ é o rastro', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    await withConsumer({ queues }, async ({ processor }) => {
      const first = await sendWager(client, queues, wallet, { amount: '25.00' });
      await waitFor('1ª processada', () => processor.outcomes.length === 1);
      await sendWager(client, queues, wallet, {
        amount: '30.00', externalTransactionId: first.data.externalTransactionId, idempotencyKey: first.data.idempotencyKey,
      });

      await waitFor('mensagem na DLQ', async () => (await peek(client, queues.dlqUrl)).length > 0);

      const [inDlq] = await peek(client, queues.dlqUrl);
      expect(inDlq?.MessageAttributes?.['FailureReason']?.StringValue).toBe('IDEMPOTENCY_CONFLICT');
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    });
  });
});

describe('erros transitórios: sem ack, backoff e DLQ pelo redrive do SQS', () => {
  /** Postgres "indisponível" de verdade: ORM real apontando para uma porta onde ninguém escuta (ECONNREFUSED). */
  async function unreachablePostgres() {
    const dead = await MikroORM.init({ ...createOrmConfig(), clientUrl: 'postgres://wager:wager@127.0.0.1:1/wager' });
    return { dead, uow: new MikroOrmUnitOfWork(dead, { retry: { attempts: 2, baseDelayMs: 1 } }) };
  }

  test('Postgres fora: não dá ack e ajusta a visibilidade com backoff exponencial pelo ApproximateReceiveCount', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    const { dead, uow: deadUow } = await unreachablePostgres();
    const acknowledged: string[] = [];
    const visibility: number[] = [];
    const interceptors: QueueInterceptors = {
      onAcknowledge: async (m, next) => { acknowledged.push(m.id); await next(); },
      onChangeVisibility: async (_m, seconds, next) => { visibility.push(seconds); await next(); },
    };
    try {
      // random = 1 => o teto da faixa: base·2^(n-1) = 1, 2, 4... (segundos)
      await withConsumer(
        { queues, unitOfWork: deadUow, interceptors, backoff: { baseSeconds: 1, maxSeconds: 8 }, random: () => 1 },
        async () => {
          await sendWager(client, queues, wallet);

          await waitFor('2 falhas transitórias com backoff', () => visibility.length >= 2, 20_000);

          expect(visibility.slice(0, 2)).toEqual([1, 2]);
          expect(acknowledged).toEqual([]);
          expect(await isQueueEmpty(client, queues.mainUrl)).toBe(false);
          expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
          expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
        },
      );
    } finally {
      await dead.close(true);
    }
  });

  test('5 recebimentos sem sucesso: o SQS move a mensagem para a DLQ com o MessageGroupId, sem nenhum ack', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    const { dead, uow: deadUow } = await unreachablePostgres();
    const acknowledged: string[] = [];
    const receiveCounts: number[] = [];
    const interceptors: QueueInterceptors = {
      onReceive: async (next) => {
        const messages = await next();
        for (const m of messages) receiveCounts.push(m.receiveCount);
        return messages;
      },
      onAcknowledge: async (m, next) => { acknowledged.push(m.id); await next(); },
    };
    try {
      await withConsumer({ queues, unitOfWork: deadUow, interceptors }, async () => {
        const message = await sendWager(client, queues, wallet);

        await waitFor('mensagem na DLQ', async () => (await peek(client, queues.dlqUrl)).length > 0, 30_000);

        const [inDlq] = await peek(client, queues.dlqUrl);
        expect(JSON.parse(inDlq?.Body ?? '{}').messageId).toBe(message.messageId);
        expect(inDlq?.Attributes?.['MessageGroupId']).toBe(wallet.id);
        expect(receiveCounts).toEqual([1, 2, 3, 4, 5]);
        expect(acknowledged).toEqual([]);
        expect(await isQueueEmpty(client, queues.mainUrl)).toBe(true);
        expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
      });
    } finally {
      await dead.close(true);
    }
  });

  test('o Postgres volta: a mesma mensagem é reentregue e processada uma única vez', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    const { dead, uow: deadUow } = await unreachablePostgres();
    let healthy = false;
    // O UnitOfWork muda de "fora do ar" para o real; a fila e o consumidor são os mesmos o tempo todo.
    const flaky: UnitOfWork = { run: (w) => (healthy ? uow : deadUow).run(w), read: (w) => (healthy ? uow : deadUow).read(w) };
    try {
      await withConsumer({ queues, unitOfWork: flaky }, async ({ processor }) => {
        const message = await sendWager(client, queues, wallet, { amount: '25.00' });
        await waitFor('1ª tentativa falhou', () => processor.outcomes.length >= 1);
        healthy = true;

        await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl), 20_000);

        expect(await transactionRows(message.data.externalTransactionId)).toHaveLength(1);
        expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
        expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
      });
    } finally {
      await dead.close(true);
    }
  });
});

describe('concorrência dentro do processo', () => {
  test('grupos diferentes em paralelo, respeitando o limite configurável', async () => {
    const queues = await newQueues(client);
    const wallets = await Promise.all(Array.from({ length: 6 }, () => newWallet()));
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => undefined;
    const reachedThree = new Promise<void>((resolve) => { release = resolve; });
    // Só avança quando 3 mensagens de grupos diferentes estão em voo AO MESMO TEMPO: se o consumidor fosse sequencial, travaria.
    const processor = new RecordingProcessor(uow, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active >= 3) release();
      await Promise.race([reachedThree, new Promise((_, reject) => setTimeout(() => reject(new Error('sem paralelismo entre grupos')), 10_000))]);
    });
    const decorated = {
      execute: async (...args: Parameters<RecordingProcessor['execute']>) => {
        try {
          return await processor.execute(...args);
        } finally {
          active -= 1;
        }
      },
    };
    const queue = new InterceptingQueue(new SqsMessageQueue(client, queues.names));
    const { consumer } = createTestConsumer({ queue, processor: decorated, consume: { concurrency: 3 } });
    for (const wallet of wallets) await sendWager(client, queues, wallet);
    consumer.start();
    try {
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));
    } finally {
      await consumer.stop();
    }

    expect(maxActive).toBe(3);
    for (const wallet of wallets) expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
  });

  test('o mesmo grupo (wallet) nunca roda em paralelo dentro do processo, mesmo em um único lote', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('1000.00');
    let active = 0;
    let maxActive = 0;
    const processor = new RecordingProcessor(uow, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    });
    const decorated = {
      execute: async (...args: Parameters<RecordingProcessor['execute']>) => {
        try {
          return await processor.execute(...args);
        } finally {
          active -= 1;
        }
      },
    };
    // 8 mensagens da mesma wallet entram na fila ANTES do consumidor: o SQS devolve várias do mesmo grupo no mesmo lote.
    for (let i = 0; i < 8; i += 1) await sendWager(client, queues, wallet, { amount: '10.00' });
    const queue = new InterceptingQueue(new SqsMessageQueue(client, queues.names));
    const { consumer } = createTestConsumer({ queue, processor: decorated, consume: { concurrency: 8 } });
    consumer.start();
    try {
      await waitFor('fila vazia', () => isQueueEmpty(client, queues.mainUrl));
    } finally {
      await consumer.stop();
    }

    expect(maxActive).toBe(1);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '920.00', rebuilt: '920.00', entries: 9 });
  });
});

describe('shutdown (SIGTERM)', () => {
  test('espera as em andamento; o que não termina no prazo volta com ChangeMessageVisibility(0), inclusive o que nem começou', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    // Outra conexão segura o lock da wallet: o processamento fica EM ANDAMENTO (esperando o lock) até o teste liberar.
    const holder = await probe.connect();
    await holder.query('BEGIN');
    await holder.query('select id from wallets where id = $1 for no key update', [wallet.id]);
    const slowUow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 60_000 });
    const returned: { id: string; seconds: number }[] = [];
    const acknowledged: string[] = [];
    const interceptors: QueueInterceptors = {
      onChangeVisibility: async (m, seconds, next) => { returned.push({ id: m.id, seconds }); await next(); },
      onAcknowledge: async (m, next) => { acknowledged.push(m.id); await next(); },
    };
    const processor = new RecordingProcessor(slowUow);
    const sent = [] as string[];
    // 3 mensagens da mesma wallet: a 1ª fica em andamento; as outras 2 esperam na fila do grupo (não começaram).
    for (let i = 0; i < 3; i += 1) sent.push((await sendWager(client, queues, wallet, { amount: '10.00' })).data.externalTransactionId);
    try {
      await withConsumer({ queues, interceptors, processor, consume: { shutdownTimeoutMs: 300, concurrency: 5 } }, async ({ consumer }) => {
        await waitFor('1ª mensagem em andamento', () => processor.started >= 1);
        const stoppedAt = Date.now();

        await consumer.stop();

        expect(Date.now() - stoppedAt).toBeLessThan(5000);
        expect(new Set(returned.map((r) => r.id)).size).toBe(3);
        expect(returned.every((r) => r.seconds === 0)).toBe(true);
        expect(acknowledged).toEqual([]);
        // De volta à fila, visíveis para outro consumidor, com o recebimento contado.
        const redelivered = await peek(client, queues.mainUrl, { visibility: 30, max: 1 });
        expect(redelivered).toHaveLength(1);
        expect(Number.parseInt(redelivered[0]?.Attributes?.['ApproximateReceiveCount'] ?? '0', 10)).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // A que estava em voo termina depois de liberado o lock: o commit é válido (a reentrega seria uma duplicata do inbox).
    await waitFor('em andamento concluiu', async () => (await transactionRows(sent[0] ?? '')).length === 1);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
  });

  test('stop() sem nada em andamento retorna logo e depois dele nenhuma mensagem é buscada', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet();
    let receives = 0;
    const interceptors: QueueInterceptors = { onReceive: async (next) => { receives += 1; return next(); } };
    await withConsumer({ queues, interceptors }, async ({ consumer }) => {
      await waitFor('já fez long polling', () => receives >= 1);
      const startedAt = Date.now();

      await consumer.stop();

      expect(Date.now() - startedAt).toBeLessThan(3000);
      const after = receives;
      await sendWager(client, queues, wallet);
      await Bun.sleep(1500); // janela para PROVAR que nada é buscado depois do stop
      expect(receives).toBe(after);
      // Não foi processada nem apagada. (Pode estar em voo: um long polling abortado no cliente ainda vive no servidor até o fim da espera.)
      expect(await isQueueEmpty(client, queues.mainUrl)).toBe(false);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
    });
  });
});
