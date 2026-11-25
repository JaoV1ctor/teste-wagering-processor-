// Replay por idempotência também registra o inbox: sem isso, um `messageId` visto só em replay poderia voltar com outro conteúdo e passar.
// Aplicação HTTP real, Postgres real e MiniStack real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildWagerMessage } from '../../scripts/send-wager-message';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { WAGER_CONSUMER_NAME } from '../../src/interface/sqs/wager-message-handler';
import type { WagerTransactionRequested } from '../../src/interface/sqs/wager-transaction-message';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { createTestConsumer, isQueueEmpty, newQueues, peek, RecordingProcessor, sendRaw, type TestQueues, waitFor } from '../support/sqs';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

const probe = createProbe(4);
let api: Api;
let orm: MikroORM;
let client: SQSClient;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  client = createSqsClient();
});
afterAll(async () => {
  await api.close();
  await probe.end();
  await orm.close();
  client.destroy();
});

type Wallet = Awaited<ReturnType<typeof openWallet>>;

/** BET aceita pelo HTTP e a mensagem SQS que pede exatamente a mesma transação, com a mesma chave. */
async function betOverHttp(wallet: Wallet, amount: string, messageId: string): Promise<WagerTransactionRequested> {
  const bet = wagerPayload(wallet, { money: { amount, currency: 'BRL' } });
  const key = defaultKey(bet);
  expect((await submit(api, bet, key)).status).toBe(201);
  const message = buildWagerMessage({
    providerId: bet.providerId, externalTransactionId: bet.externalTransactionId, idempotencyKey: key, playerId: bet.playerId,
    walletId: bet.walletId, roundId: bet.roundId, gameId: bet.gameId, kind: bet.kind, amount, currency: 'BRL',
  });
  return { ...message, messageId };
}

/** Consumidor real sobre filas reais. `deliver` envia (cada envio com outro MessageDeduplicationId) e espera o ack da fila principal. */
async function withConsumer(body: (ctx: { queues: TestQueues; processor: RecordingProcessor; deliver: (message: WagerTransactionRequested) => Promise<void> }) => Promise<void>) {
  const queues = await newQueues(client);
  const processor = new RecordingProcessor(new MikroOrmUnitOfWork(orm));
  const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(client, queues.names), processor });
  let delivered = 0;
  const deliver = async (message: WagerTransactionRequested) => {
    await sendRaw(client, queues.mainUrl, JSON.stringify(message), { groupId: message.data.walletId });
    delivered += 1;
    await waitFor(`entrega ${delivered} processada`, () => processor.outcomes.length === delivered);
    await waitFor('fila principal vazia', () => isQueueEmpty(client, queues.mainUrl));
  };
  consumer.start();
  try {
    await body({ queues, processor, deliver });
  } finally {
    await consumer.stop();
  }
}

const inbox = async (messageId: string) =>
  (await probe.query<{ processed: boolean }>(
    'select processed_at is not null as processed from inbox_messages where consumer_name = $1 and message_id = $2', [WAGER_CONSUMER_NAME, messageId],
  )).rows;

const deadLetterReasons = async (queues: TestQueues) =>
  (await peek(client, queues.dlqUrl)).map((m) => m.MessageAttributes?.['FailureReason']?.StringValue);

describe('HTTP, depois replay por SQS com messageId M, depois M reutilizado', () => {
  test('o replay confirma a mensagem, não debita e registra M no inbox', async () => {
    const wallet = await openWallet(api, '100.00');
    const messageId = `msg-${uuid()}`;
    const replay = await betOverHttp(wallet, '25.00', messageId);
    await withConsumer(async ({ queues, processor, deliver }) => {
      await deliver(replay);

      expect(processor.outcomes[0]).toMatchObject({ idempotentReplay: true });
      expect(await inbox(messageId)).toEqual([{ processed: true }]);
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
      expect(await deadLetterReasons(queues)).toEqual([]);
    });
  });

  test('M com outra chave e outra transação (payload diferente): permanente, vai à DLQ e NÃO debita', async () => {
    const wallet = await openWallet(api, '100.00');
    const messageId = `msg-${uuid()}`;
    const replay = await betOverHttp(wallet, '25.00', messageId);
    const reused = {
      ...replay,
      data: { ...replay.data, idempotencyKey: `k-${uuid()}`, externalTransactionId: `ext-${uuid()}`, money: { amount: '40.00', currency: 'BRL' } },
    };
    await withConsumer(async ({ queues, deliver }) => {
      await deliver(replay);
      await deliver(reused);

      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
      expect((await probe.query('select 1 from wager_transactions where external_transaction_id = $1', [reused.data.externalTransactionId])).rows).toHaveLength(0);
      expect(await deadLetterReasons(queues)).toEqual(['INBOX_PAYLOAD_CONFLICT']);
    });
  });

  test('M apontando para OUTRA transação já processada (chave conhecida, payload diferente): permanente, não é replay', async () => {
    const wallet = await openWallet(api, '100.00');
    const messageId = `msg-${uuid()}`;
    const first = await betOverHttp(wallet, '25.00', messageId);
    const second = await betOverHttp(wallet, '10.00', messageId);
    await withConsumer(async ({ queues, deliver }) => {
      await deliver(first);
      await deliver(second);

      expect(await deadLetterReasons(queues)).toEqual(['INBOX_PAYLOAD_CONFLICT']);
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '65.00', rebuilt: '65.00', entries: 3 });
    });
  });

  test('M com outra chave e o MESMO payload: duplicata do inbox, ack sem DLQ e sem débito', async () => {
    const wallet = await openWallet(api, '100.00');
    const messageId = `msg-${uuid()}`;
    const replay = await betOverHttp(wallet, '25.00', messageId);
    await withConsumer(async ({ queues, processor, deliver }) => {
      await deliver(replay);
      await deliver({ ...replay, data: { ...replay.data, idempotencyKey: `k-${uuid()}` } });

      expect(processor.outcomes[1]).toEqual({ duplicateMessage: true });
      expect(await deadLetterReasons(queues)).toEqual([]);
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    });
  });
});
