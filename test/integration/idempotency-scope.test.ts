// A Idempotency-Key vale DENTRO de um provedor: dois provedores com a mesma chave são independentes; no mesmo provedor ela continua
// decidindo entre replay e conflito. HTTP e SQS reais, Postgres real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsMessageQueue } from '../../src/infrastructure/messaging/sqs-message-queue';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { createTestConsumer, isQueueEmpty, newQueues, peek, RecordingProcessor, sendWager, type TestQueues, waitFor } from '../support/sqs';
import { openWallet, submit, wagerPayload, type WagerPayload } from '../support/wager';

const probe = createProbe(4);
let api: Api;
let orm: MikroORM;
let sqs: SQSClient;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  sqs = createSqsClient();
});
afterAll(async () => {
  await api.close();
  await orm.close();
  await probe.end();
  sqs.destroy();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });
type Wallet = { walletId: string; playerId: string };
const provider = (name: string) => `${name}-${uuid()}`;
const bet = (wallet: Wallet, providerId: string, amount: string, overrides: Partial<WagerPayload> = {}) =>
  wagerPayload(wallet, { providerId, money: money(amount), ...overrides });
const rowsWithKey = async (key: string) =>
  (await probe.query<{ id: string; provider_id: string; wallet_id: string }>(
    'select id, provider_id, wallet_id from wager_transactions where idempotency_key = $1 order by provider_id', [key],
  )).rows; // sem filtro de provedor DE PROPÓSITO: o teste conta quantos provedores usaram a chave

describe('HTTP: dois provedores com a mesma Idempotency-Key', () => {
  test('ambos aceitos, cada um com a própria transação, saldo e ledger; nenhum dado de um na resposta do outro', async () => {
    const [walletA, walletB] = [await openWallet(api, '500.00'), await openWallet(api, '90.00')];
    const [a, b] = [bet(walletA, provider('alfa'), '123.00'), bet(walletB, provider('beta'), '7.00')];
    const key = `compartilhada-${uuid()}`;

    const first = await submit(api, a, key);
    const second = await submit(api, b, key);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: money('377.00') });
    expect(second.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: money('83.00') });
    expect(second.body.transactionId).not.toBe(first.body.transactionId);
    for (const secret of [first.body.transactionId, walletA.walletId, walletA.playerId, a.externalTransactionId, '377.00']) {
      expect(JSON.stringify(second.body)).not.toContain(secret);
    }
    expect((await rowsWithKey(key)).map((row) => [row.provider_id, row.wallet_id])).toEqual([[a.providerId, walletA.walletId], [b.providerId, walletB.walletId]]);
    expect(await ledgerBalance(probe, walletA.walletId)).toEqual({ stored: '377.00', rebuilt: '377.00', entries: 2 });
    expect(await ledgerBalance(probe, walletB.walletId)).toEqual({ stored: '83.00', rebuilt: '83.00', entries: 2 });
  });

  test('mesma chave e mesmo id externo na mesma wallet, provedores diferentes: duas transações independentes', async () => {
    const wallet = await openWallet(api, '100.00');
    const a = bet(wallet, provider('alfa'), '10.00');
    const b = { ...a, providerId: provider('beta') };
    const key = `compartilhada-${uuid()}`;

    const [first, second] = [await submit(api, a, key), await submit(api, b, key)];

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.transactionId).not.toBe(first.body.transactionId);
    expect(second.body.idempotentReplay).toBe(false);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 3 });
  });

  test('cada provedor recebe o PRÓPRIO replay, mesmo depois de o outro usar a chave', async () => {
    const [walletA, walletB] = [await openWallet(api, '100.00'), await openWallet(api, '100.00')];
    const [a, b] = [bet(walletA, provider('alfa'), '10.00'), bet(walletB, provider('beta'), '20.00')];
    const key = `compartilhada-${uuid()}`;
    const [firstA, firstB] = [await submit(api, a, key), await submit(api, b, key)];

    const [replayA, replayB] = [await submit(api, a, key), await submit(api, b, key)];

    expect([replayA.status, replayB.status]).toEqual([201, 201]);
    expect(replayA.body).toEqual({ ...firstA.body, idempotentReplay: true });
    expect(replayB.body).toEqual({ ...firstB.body, idempotentReplay: true });
    expect(await rowsWithKey(key)).toHaveLength(2);
  });

  test('mesmo provedor, mesma chave, payload diferente: 409, mesmo havendo outro provedor com a chave; nada muda', async () => {
    const [walletA, walletB] = [await openWallet(api, '100.00'), await openWallet(api, '100.00')];
    const [a, b] = [bet(walletA, provider('alfa'), '10.00'), bet(walletB, provider('beta'), '20.00')];
    const key = `compartilhada-${uuid()}`;
    await submit(api, a, key);
    await submit(api, b, key);

    // B envia o payload de A trocando só o providerId pelo próprio: dentro de B a chave já tem outro conteúdo.
    const asB = await submit(api, { ...a, providerId: b.providerId }, key);
    const changed = await submit(api, { ...a, money: money('10.01') }, key);

    expect([asB.status, changed.status]).toEqual([409, 409]);
    expect([asB.body.code, changed.body.code]).toEqual(['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT']);
    expect(await rowsWithKey(key)).toHaveLength(2);
    expect(await ledgerBalance(probe, walletA.walletId)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
    expect(await ledgerBalance(probe, walletB.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 2 });
  });
});

describe('SQS: o mesmo escopo pela fila', () => {
  async function drain(queues: TestQueues, send: () => Promise<unknown>): Promise<RecordingProcessor> {
    const processor = new RecordingProcessor(new MikroOrmUnitOfWork(orm));
    const { consumer } = createTestConsumer({ queue: new SqsMessageQueue(sqs, queues.names), processor });
    consumer.start();
    try {
      await send();
      await waitFor('fila de entrada vazia', () => isQueueEmpty(sqs, queues.mainUrl), 30_000);
    } finally {
      await consumer.stop();
    }
    return processor;
  }
  const queued = (wallet: Wallet) => ({ id: wallet.walletId, playerId: wallet.playerId });
  const deadLetters = async (queues: TestQueues) =>
    (await peek(sqs, queues.dlqUrl)).map((message) => message.MessageAttributes?.['FailureReason']?.StringValue);

  test('dois provedores com a mesma chave: as duas aplicadas, nada na DLQ; a reentrega de cada uma é replay', async () => {
    const queues = await newQueues(sqs);
    const [walletA, walletB] = [await openWallet(api, '100.00'), await openWallet(api, '100.00')];
    const idempotencyKey = `fila-${uuid()}`;
    const a = { providerId: provider('alfa'), externalTransactionId: `ext-${uuid()}`, idempotencyKey, amount: '10.00' };
    const b = { providerId: provider('beta'), externalTransactionId: `ext-${uuid()}`, idempotencyKey, amount: '20.00' };

    const processor = await drain(queues, async () => {
      await sendWager(sqs, queues, queued(walletA), a);
      await sendWager(sqs, queues, queued(walletB), b);
      await sendWager(sqs, queues, queued(walletA), a); // messageId nova, mesmo fato
      await sendWager(sqs, queues, queued(walletB), b);
    });

    const replays = processor.outcomes.map((o) => (o instanceof Error ? o.name : 'transaction' in o ? o.idempotentReplay : 'duplicate'));
    expect(replays.sort()).toEqual([false, false, true, true]);
    expect(await deadLetters(queues)).toEqual([]);
    expect(await rowsWithKey(idempotencyKey)).toHaveLength(2);
    expect(await ledgerBalance(probe, walletA.walletId)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
    expect(await ledgerBalance(probe, walletB.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 2 });
  });

  test('mesmo provedor, mesma chave, payload diferente: DLQ IDEMPOTENCY_CONFLICT, sem segundo efeito', async () => {
    const queues = await newQueues(sqs);
    const wallet = await openWallet(api, '100.00');
    const first = { providerId: provider('alfa'), externalTransactionId: `ext-${uuid()}`, idempotencyKey: `fila-${uuid()}`, amount: '10.00' };

    await drain(queues, async () => {
      await sendWager(sqs, queues, queued(wallet), first);
      await sendWager(sqs, queues, queued(wallet), { ...first, amount: '99.00' });
    });

    expect(await deadLetters(queues)).toEqual(['IDEMPOTENCY_CONFLICT']);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 });
  });

  test('HTTP de um provedor e fila de outro com a mesma chave não se confundem', async () => {
    const queues = await newQueues(sqs);
    const [walletA, walletB] = [await openWallet(api, '100.00'), await openWallet(api, '100.00')];
    const key = `mista-${uuid()}`;
    const http = await submit(api, bet(walletA, provider('alfa'), '10.00'), key);

    const processor = await drain(queues, () =>
      sendWager(sqs, queues, queued(walletB), { providerId: provider('beta'), idempotencyKey: key, amount: '20.00' }));

    expect(http.status).toBe(201);
    expect(processor.outcomes).toEqual([expect.objectContaining({ idempotentReplay: false })]);
    expect(await deadLetters(queues)).toEqual([]);
    expect(await ledgerBalance(probe, walletB.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 2 });
  });
});
