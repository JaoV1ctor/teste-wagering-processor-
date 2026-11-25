// Cenário #5 e consumidores concorrentes. Postgres REAL, MiniStack REAL. O único dublê decora a fila real para "matar o worker".
// Invariante final em todos: wallet.balance == saldo reconstruído pelo ledger.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { Money } from '../../src/domain/money';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { WAGER_CONSUMER_NAME } from '../../src/interface/sqs/wager-message-handler';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { expectEventsConsistentWithLedger, outboxOfWallet, typesOf } from '../support/events';
import {
  createTestConsumer, InterceptingQueue, isQueueEmpty, newQueues, type Outcome, RecordingProcessor, sendRaw, sendWager, type TestQueues, type TestWallet,
  waitFor,
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

const newWallet = async (balance = '100.00'): Promise<TestWallet> => {
  const wallet = await new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: Money.fromString(balance, 'BRL') });
  return { id: wallet.id, playerId: wallet.playerId };
};
const transactionCount = async (externalTransactionId: string) =>
  (await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [externalTransactionId])).rows.length;
const inboxCount = async (messageId: string) =>
  (await probe.query('select 1 from inbox_messages where consumer_name = $1 and message_id = $2', [WAGER_CONSUMER_NAME, messageId])).rows.length;
const isFirstProcessing = (outcome: Outcome) => !(outcome instanceof Error) && 'transaction' in outcome && !outcome.idempotentReplay;

/**
 * Sobe `consumer-child.ts` (um consumidor completo em outro processo) nas filas do teste e espera o `READY`. `waitForLine` espera o filho
 * imprimir uma linha.
 */
async function spawnConsumer(queues: TestQueues, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, 'test/support/consumer-child.ts'], {
    env: { ...process.env, SQS_WAGER_QUEUE_NAME: queues.names.queueName, SQS_WAGER_DLQ_NAME: queues.names.deadLetterQueueName, ...env },
    stdout: 'pipe', stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  let output = '';
  const waitForLine = async (line: string, timeoutMs = 30_000): Promise<void> => {
    // O prazo mata o filho: a leitura termina, o teste falha com a mensagem certa e nenhum processo sobra.
    const deadline = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
      while (!output.includes(line)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`o processo filho terminou (ou passou do prazo) sem imprimir ${line}`);
        output += new TextDecoder().decode(value);
      }
    } finally {
      clearTimeout(deadline);
    }
  };
  await waitForLine('READY');
  return { process: child, waitForLine };
}

describe('#5 processo real morto (SIGKILL) depois do commit e antes do ack', () => {
  test('o commit sobrevive, a mensagem é reentregue e outra instância a confirma sem repetir débito, ledger, inbox ou evento', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('100.00');
    // O filho processa e commita; ao chegar no ack avisa e fica parado, sem nunca enviar o DeleteMessage. Nesse instante é morto.
    const child = await spawnConsumer(queues, { CONSUMER_HANG_BEFORE_ACK: '1' });
    let message: Awaited<ReturnType<typeof sendWager>>;
    try {
      message = await sendWager(client, queues, wallet, { amount: '30.00' });
      await child.waitForLine('ACK-PENDENTE');
      expect(child.process.exitCode).toBeNull(); // ainda vivo: quem o encerra é o SIGKILL
    } finally {
      child.process.kill('SIGKILL');
      await child.process.exited;
    }
    expect(child.process.signalCode).toBe('SIGKILL');

    const state = async () => ({
      transactions: await transactionCount(message.data.externalTransactionId),
      inbox: await inboxCount(message.messageId),
      balance: await ledgerBalance(probe, wallet.id),
      events: typesOf(await outboxOfWallet(probe, wallet.id)),
    });
    const committed = {
      transactions: 1, inbox: 1, balance: { stored: '70.00', rebuilt: '70.00', entries: 2 }, events: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    };
    // Estado exato do crash: tudo commitado, nada confirmado.
    expect(await state()).toEqual(committed);
    expect(await isQueueEmpty(client, queues.mainUrl)).toBe(false);

    const survivor = new RecordingProcessor(uow);
    const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor: survivor });
    consumer.start();
    try {
      await waitFor('mensagem reentregue e confirmada', () => isQueueEmpty(client, queues.mainUrl), 30_000);
    } finally {
      await consumer.stop();
    }

    expect(survivor.outcomes).toEqual([{ duplicateMessage: true }]);
    expect(await state()).toEqual(committed);
    await expectEventsConsistentWithLedger(probe, wallet.id);
    expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
  }, 90_000);
});

describe('#5 worker morre depois do commit e antes do ack (falha no ack, no mesmo processo)', () => {
  test('a mensagem é reentregue e o reprocessamento não duplica débito, ledger nem inbox', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('100.00');
    let crashed = false;
    const dyingQueue = new InterceptingQueue(new SqsMessageQueue(client, queues.names), {
      // O commit já aconteceu quando o consumidor chega aqui. O worker "morre": o DeleteMessage nunca é enviado.
      onAcknowledge: async () => {
        crashed = true;
        throw new Error('worker morreu depois do commit e antes do ack');
      },
    });
    const first = createTestConsumer({
      queue: dyingQueue, processor: new RecordingProcessor(uow), consume: { visibilityTimeoutSeconds: 2 },
    });
    const message = await sendWager(client, queues, wallet, { amount: '30.00' });

    first.consumer.start();
    await waitFor('worker 1 chegou ao ack', () => crashed);
    await first.consumer.stop(); // o worker 1 está morto: não busca mais nada

    // Estado exato do crash: efeitos commitados, mensagem ainda na fila.
    expect(await transactionCount(message.data.externalTransactionId)).toBe(1);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect(await isQueueEmpty(client, queues.mainUrl)).toBe(false);

    // Outro worker (instância nova) recebe a MESMA mensagem quando a visibilidade vence.
    const survivor = new RecordingProcessor(uow);
    const second = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor: survivor });
    second.consumer.start();
    try {
      await waitFor('mensagem reentregue e confirmada', () => isQueueEmpty(client, queues.mainUrl), 30_000);
    } finally {
      await second.consumer.stop();
    }

    expect(survivor.outcomes).toHaveLength(1);
    expect(survivor.outcomes).toEqual([{ duplicateMessage: true }]); // o inbox, commitado junto com o débito, reconhece a messageId
    expect(await transactionCount(message.data.externalTransactionId)).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
  });

  test('o mesmo com várias wallets: o worker morre em todas as primeiras entregas e cada débito acontece uma única vez', async () => {
    const queues = await newQueues(client);
    const wallets = await Promise.all(Array.from({ length: 4 }, () => newWallet('100.00')));
    const crashed = new Set<string>();
    const dyingQueue = new InterceptingQueue(new SqsMessageQueue(client, queues.names), {
      onAcknowledge: async (message) => {
        crashed.add(message.id);
        throw new Error('worker morreu antes do ack');
      },
    });
    const first = createTestConsumer({ queue: dyingQueue, processor: new RecordingProcessor(uow), consume: { visibilityTimeoutSeconds: 2 } });
    const sent = await Promise.all(wallets.map((wallet) => sendWager(client, queues, wallet, { amount: '10.00' })));

    first.consumer.start();
    await waitFor('worker 1 chegou ao ack das 4', () => crashed.size === 4);
    await first.consumer.stop();
    for (const wallet of wallets) expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });

    const survivor = new RecordingProcessor(uow);
    const second = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor: survivor });
    second.consumer.start();
    try {
      await waitFor('4 mensagens reentregues e confirmadas', () => isQueueEmpty(client, queues.mainUrl), 30_000);
    } finally {
      await second.consumer.stop();
    }

    expect(survivor.outcomes).toEqual(Array.from({ length: 4 }, () => ({ duplicateMessage: true })));
    for (const message of sent) expect(await transactionCount(message.data.externalTransactionId)).toBe(1);
    for (const wallet of wallets) expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
  });
});

describe('#5b worker morre ANTES do commit (processo real, SIGKILL)', () => {
  test('o ack não aconteceu, a transação abortou com a conexão e a mensagem é reentregue e processada uma única vez', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('100.00');
    // O teste segura o lock da wallet: o filho recebe a mensagem e fica DENTRO da transação, esperando o lock. Nesse instante, morre.
    const holder = await probe.connect();
    await holder.query('BEGIN');
    await holder.query('select id from wallets where id = $1 for no key update', [wallet.id]);
    const { process: child } = await spawnConsumer(queues);
    try {
      const message = await sendWager(client, queues, wallet, { amount: '30.00' });
      await waitFor('filho dentro da transação, esperando o lock da wallet', async () => {
        const { rows } = await probe.query("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%wallets%'");
        return rows.length > 0;
      });

      child.kill('SIGKILL');
      await child.exited;
      await holder.query('ROLLBACK');

      // Nada commitou e nada foi confirmado: a mensagem continua na fila (em voo até a visibilidade vencer).
      expect(await transactionCount(message.data.externalTransactionId)).toBe(0);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
      expect(await isQueueEmpty(client, queues.mainUrl)).toBe(false);

      const survivor = new RecordingProcessor(uow);
      const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor: survivor });
      consumer.start();
      try {
        await waitFor('mensagem reentregue e confirmada', () => isQueueEmpty(client, queues.mainUrl), 30_000);
      } finally {
        await consumer.stop();
      }

      expect(survivor.outcomes).toHaveLength(1);
      expect(survivor.outcomes[0]).toMatchObject({ idempotentReplay: false }); // 1º processamento de verdade: o filho não commitou nada
      expect(await transactionCount(message.data.externalTransactionId)).toBe(1);
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
      expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      holder.release();
    }
  });
});

describe('consumidores concorrentes (2 instâncias, cada uma com o próprio pool)', () => {
  test('mensagens, duplicatas e redeliveries disputadas por 2 consumidores: cada efeito acontece exatamente uma vez', async () => {
    const queues = await newQueues(client);
    const WALLETS = 6;
    const PER_WALLET = 8;
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => newWallet('100.00')));
    const uniqueMessages: Awaited<ReturnType<typeof sendWager>>[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < PER_WALLET; i += 1) {
        const message = await sendWager(client, queues, wallet, { amount: '5.00' });
        uniqueMessages.push(message);
        // (a) duplicata da MESMA mensagem (outro MessageDeduplicationId: o SQS entrega as duas)
        await sendRaw(client, queues.mainUrl, JSON.stringify(message), { groupId: wallet.id });
        // (b) a mesma transação reenviada com messageId NOVA (o produtor gerou outra mensagem para o mesmo fato)
        await sendWager(client, queues, wallet, {
          amount: '5.00', externalTransactionId: message.data.externalTransactionId, idempotencyKey: message.data.idempotencyKey,
        });
      }
    }

    const otherOrm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
    const processors = [new RecordingProcessor(uow), new RecordingProcessor(new MikroOrmUnitOfWork(otherOrm))];
    const consumers = processors.map((processor) =>
      createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor, consume: { concurrency: 4 } }).consumer,
    );
    for (const consumer of consumers) consumer.start();
    try {
      await waitFor('as 144 mensagens confirmadas', () => isQueueEmpty(client, queues.mainUrl), 90_000);
    } finally {
      await Promise.all(consumers.map((consumer) => consumer.stop()));
      await otherOrm.close();
    }

    const outcomes = processors.flatMap((p) => p.outcomes);
    expect(outcomes.filter((o) => o instanceof Error)).toEqual([]);
    expect(outcomes.filter(isFirstProcessing)).toHaveLength(WALLETS * PER_WALLET); // exatamente um processamento por fato
    expect(outcomes).toHaveLength(WALLETS * PER_WALLET * 3);
    for (const wallet of wallets) {
      // 100.00 - 8 x 5.00; OPENING + 8 débitos
      expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '60.00', rebuilt: '60.00', entries: PER_WALLET + 1 });
    }
    for (const message of uniqueMessages) {
      expect(await transactionCount(message.data.externalTransactionId)).toBe(1);
      expect(await inboxCount(message.messageId)).toBeLessThanOrEqual(1);
    }
    expect(await isQueueEmpty(client, queues.dlqUrl)).toBe(true);
  });

  test('uma wallet quente (todas as mensagens no mesmo grupo) com 2 consumidores: ordem e saldo corretos', async () => {
    const queues = await newQueues(client);
    const wallet = await newWallet('50.00');
    // Cada BET de 10.00 só passa se o saldo permitir: 5 passam e 3 são rejeitadas, de forma determinística pela ordem de envio.
    const sent = [];
    for (let i = 0; i < 8; i += 1) sent.push(await sendWager(client, queues, wallet, { amount: '10.00' }));

    const otherOrm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
    const processors = [new RecordingProcessor(uow), new RecordingProcessor(new MikroOrmUnitOfWork(otherOrm))];
    const consumers = processors.map((processor) => createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor }).consumer);
    for (const consumer of consumers) consumer.start();
    try {
      await waitFor('as 8 mensagens confirmadas', () => isQueueEmpty(client, queues.mainUrl), 60_000);
    } finally {
      await Promise.all(consumers.map((consumer) => consumer.stop()));
      await otherOrm.close();
    }

    // Status na ORDEM DE ENVIO: só a ordem do grupo explica 5 PROCESSED seguidas de 3 REJECTED.
    const statuses: (string | undefined)[] = [];
    for (const message of sent) {
      const { rows } = await probe.query<{ status: string }>('select status from wager_transactions where external_transaction_id = $1', [message.data.externalTransactionId]);
      statuses.push(rows[0]?.status);
    }
    expect(statuses).toEqual([...Array(5).fill('PROCESSED'), ...Array(3).fill('REJECTED')]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '0.00', rebuilt: '0.00', entries: 6 });
  });
});
