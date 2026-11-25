// Eventos de integração gravados no outbox NA MESMA transação do processamento. Postgres REAL, aplicação real.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { buildWagerMessage } from '../../scripts/send-wager-message';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { WAGER_CONSUMER_NAME, WagerMessageHandler } from '../../src/interface/sqs/wager-message-handler';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance, parkPendingReferences } from '../support/db';
import { expectEventsConsistentWithLedger, outboxOfTransaction, outboxOfWallet, typesOf } from '../support/events';
import { defaultKey, openWallet, reversalPayload, type WagerPayload, wagerPayload } from '../support/wager';

const probe = createProbe();
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let api: Api;
let simulatedNow = 0;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
  await orm.close();
});
beforeEach(async () => {
  await parkPendingReferences(probe);
  simulatedNow = Date.now() + 60_000;
});

const money = (amount: string) => ({ amount, currency: 'BRL' });
const post = (payload: WagerPayload, headers: Record<string, string> = {}) =>
  api.call('POST', '/wagering/transactions', payload, { 'idempotency-key': defaultKey(payload), ...headers });
const worker = () =>
  new ReprocessPendingReferencesUseCase(uow, { onError: (error) => { throw error; }, clock: () => new Date(simulatedNow), random: () => 0, batchSize: 100 });

describe('quais eventos nascem de cada resultado', () => {
  test('BET processada: Processed e BalanceChanged, com o envelope e o payload esperados', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const res = await post(bet, { 'x-correlation-id': 'corr-http-1' });
    expect(res.status).toBe(201);

    const rows = await outboxOfTransaction(probe, res.body.transactionId);
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [processed, changed] = rows;
    if (!processed || !changed) throw new Error('eventos ausentes');

    expect(processed.id).toBe(processed.payload.eventId); // outbox.id = eventId
    expect(processed.aggregate_id).toBe(res.body.transactionId);
    expect(processed.published_at).toBeNull();
    expect(processed.attempts).toBe(0);
    expect(processed.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed', version: 1, aggregateId: res.body.transactionId, correlationId: 'corr-http-1',
      data: {
        transactionId: res.body.transactionId, providerId: bet.providerId, externalTransactionId: bet.externalTransactionId, walletId: wallet.walletId,
        playerId: wallet.playerId, roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: money('30.00'), balance: money('70.00'),
      },
    });
    expect(new Date(processed.payload.occurredAt).getTime()).toBe(processed.occurred_at.getTime());

    expect(changed.id).toBe(changed.payload.eventId);
    expect(changed.aggregate_id).toBe(wallet.walletId); // o agregado do saldo é a wallet
    expect(changed.payload).toMatchObject({
      eventType: 'WalletBalanceChanged', version: 1, aggregateId: wallet.walletId, correlationId: 'corr-http-1', causationId: processed.id,
      data: {
        walletId: wallet.walletId, transactionId: res.body.transactionId, direction: 'DEBIT', money: money('30.00'),
        balanceBefore: money('100.00'), balanceAfter: money('70.00'), walletVersion: 2,
      },
    });
    await expectEventsConsistentWithLedger(probe, wallet.walletId);
  });

  test('WIN: BalanceChanged CREDIT com a version seguinte', async () => {
    const wallet = await openWallet(api, '100.00');
    await post(wagerPayload(wallet, { money: money('10.00') }));
    const win = await post(wagerPayload(wallet, { kind: 'WIN', money: money('50.00') }));
    const changed = (await outboxOfTransaction(probe, win.body.transactionId)).find((row) => row.event_type === 'WalletBalanceChanged');
    expect(changed?.payload.data).toMatchObject({ direction: 'CREDIT', balanceBefore: money('90.00'), balanceAfter: money('140.00'), walletVersion: 3 });
    await expectEventsConsistentWithLedger(probe, wallet.walletId);
  });

  test('LOSS: Processed, mas NUNCA BalanceChanged (o saldo não muda)', async () => {
    const wallet = await openWallet(api, '100.00');
    const res = await post(wagerPayload(wallet, { kind: 'LOSS', money: money('30.00') }));
    expect(res.status).toBe(201);
    expect(typesOf(await outboxOfTransaction(probe, res.body.transactionId))).toEqual(['WagerTransactionProcessed']);
    expect(typesOf(await outboxOfWallet(probe, wallet.walletId))).toEqual(['WagerTransactionProcessed']);
    await expectEventsConsistentWithLedger(probe, wallet.walletId);
  });

  test('REJECTED (saldo insuficiente): só Rejected, com o failureCode e o saldo visto; nenhum BalanceChanged', async () => {
    const wallet = await openWallet(api, '10.00');
    const res = await post(wagerPayload(wallet, { money: money('500.00') }));
    expect(res.status).toBe(422);
    const rows = await outboxOfTransaction(probe, res.body.transactionId);
    expect(typesOf(rows)).toEqual(['WagerTransactionRejected']);
    expect(rows[0]?.payload).toMatchObject({
      eventType: 'WagerTransactionRejected', version: 1, aggregateId: res.body.transactionId,
      data: { transactionId: res.body.transactionId, walletId: wallet.walletId, kind: 'BET', money: money('500.00'), failureCode: 'INSUFFICIENT_BALANCE', balance: money('10.00') },
    });
    expect(typesOf(await outboxOfWallet(probe, wallet.walletId))).toEqual(['WagerTransactionRejected']);
    await expectEventsConsistentWithLedger(probe, wallet.walletId);
  });

  test('REFUND antes da BET: PendingReference na 1ª vez; o worker reagenda sem evento novo e, com a BET, gera Processed e BalanceChanged', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const refund = reversalPayload(wallet, bet, 'REFUND');

    const early = await post(refund);
    expect(early.status).toBe(202);
    const afterSubmit = await outboxOfTransaction(probe, early.body.transactionId);
    expect(typesOf(afterSubmit)).toEqual(['WagerTransactionPendingReference']);
    expect(afterSubmit[0]?.payload.data).toMatchObject({
      transactionId: early.body.transactionId, kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId, money: money('30.00'),
    });

    await worker().runOnce(); // a BET ainda não existe: só reagenda
    expect(typesOf(await outboxOfTransaction(probe, early.body.transactionId))).toEqual(['WagerTransactionPendingReference']);

    await post(bet);
    simulatedNow += 120_000;
    expect(await worker().runOnce()).toMatchObject({ processed: 1 });
    expect(typesOf(await outboxOfTransaction(probe, early.body.transactionId))).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
    await expectEventsConsistentWithLedger(probe, wallet.walletId);
  });

  test('limite do worker esgotado: Rejected (REFERENCE_NOT_FOUND) e nenhum BalanceChanged', async () => {
    const wallet = await openWallet(api, '100.00');
    const refund = reversalPayload(wallet, wagerPayload(wallet, { money: money('30.00') }), 'REFUND');
    const early = await post(refund);
    for (let i = 0; i < 7; i += 1) {
      simulatedNow += 120_000;
      await worker().runOnce();
    }
    expect(typesOf(await outboxOfTransaction(probe, early.body.transactionId))).toEqual(['WagerTransactionPendingReference']);
    simulatedNow += 120_000;
    expect(await worker().runOnce()).toMatchObject({ rejected: 1 });

    const rows = await outboxOfTransaction(probe, early.body.transactionId);
    expect(typesOf(rows)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(rows[1]?.payload.data).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND', balance: money('100.00') });
    await expectEventsConsistentWithLedger(probe, wallet.walletId);
  });
});

describe('o que NÃO gera evento', () => {
  test('replay da mesma chave não cria evento novo', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const first = await post(bet);
    const replay = await post(bet);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(typesOf(await outboxOfTransaction(probe, first.body.transactionId))).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('wallet inexistente (404): nada persiste, nem evento', async () => {
    const ghost = { walletId: uuid(), playerId: uuid() };
    const res = await post(wagerPayload(ghost));
    expect(res.status).toBe(404);
    expect(await outboxOfWallet(probe, ghost.walletId)).toEqual([]);
  });
});

describe('correlationId e causationId', () => {
  test('HTTP sem x-correlation-id: usa o id da transação', async () => {
    const wallet = await openWallet(api, '100.00');
    const res = await post(wagerPayload(wallet, { kind: 'LOSS' }));
    const [processed] = await outboxOfTransaction(probe, res.body.transactionId);
    expect(processed?.payload.correlationId).toBe(res.body.transactionId);
    expect(processed?.payload.causationId).toBeUndefined();
  });

  test('SQS: o correlationId é o messageId da mensagem (o mesmo caso de uso do HTTP grava os eventos)', async () => {
    const wallet = await openWallet(api, '100.00');
    const message = buildWagerMessage({
      providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.walletId, roundId: 'r', gameId: 'g', kind: 'BET', amount: '20.00', currency: 'BRL',
    });
    const handler = new WagerMessageHandler(new ProcessWagerTransactionUseCase(uow), {
      consumerName: WAGER_CONSUMER_NAME, backoff: { baseSeconds: 0, maxSeconds: 0 }, log: () => undefined,
    });
    expect(await handler.handle(JSON.stringify(message), 1)).toEqual({ action: 'ack' });

    const { rows } = await probe.query<{ id: string }>('select id from wager_transactions where external_transaction_id = $1', [message.data.externalTransactionId]);
    const events = await outboxOfTransaction(probe, rows[0]?.id ?? '');
    expect(typesOf(events)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events.every((row) => row.payload.correlationId === message.messageId)).toBe(true);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '80.00', rebuilt: '80.00', entries: 2 });
  });
});
