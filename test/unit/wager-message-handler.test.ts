import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError, InboxPayloadConflictError, TransientInfrastructureError, WalletNotFoundError,
} from '../../src/application/errors';
import type { DuplicateMessageResult, MessageOrigin, ProcessWagerCommand, ProcessWagerResult } from '../../src/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { type Disposition, type WagerProcessor, WagerMessageHandler } from '../../src/interface/sqs/wager-message-handler';

// Unidade: o caso de uso é um dublê (não há banco aqui). A integração com Postgres e SQS reais está em test/integration/sqs-consumer.test.ts.
const body = JSON.stringify({
  messageId: 'msg-1', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a', externalTransactionId: 'ext-1', idempotencyKey: 'provider-a:ext-1', playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  },
});

const brl = Money.fromString('25.00', 'BRL');
const newTransaction = (): WagerTransaction =>
  WagerTransaction.create({
    id: 'tx-1', providerId: 'provider-a', externalTransactionId: 'ext-1', idempotencyKey: 'k', payloadHash: 'a'.repeat(64),
    walletId: 'w', playerId: 'p', roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: brl, now: new Date(),
  });

const processed = (): ProcessWagerResult => {
  const transaction = newTransaction();
  transaction.markProcessed({ observedBalance: brl, at: new Date() });
  return { transaction, idempotentReplay: false };
};
const rejected = (): ProcessWagerResult => {
  const transaction = newTransaction();
  transaction.reject(FailureCode.InsufficientBalance, brl, new Date());
  return { transaction, idempotentReplay: false };
};
const pendingReference = (): ProcessWagerResult => {
  const transaction = newTransaction();
  transaction.markPendingReference(new Date(), new Date());
  return { transaction, idempotentReplay: false };
};

interface Call { command: ProcessWagerCommand; origin: MessageOrigin }

function handlerWith(outcome: () => Promise<ProcessWagerResult | DuplicateMessageResult>) {
  const calls: Call[] = [];
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const processor: WagerProcessor = {
    execute: (command: ProcessWagerCommand, origin: MessageOrigin) => {
      calls.push({ command, origin });
      return outcome();
    },
  };
  const handler = new WagerMessageHandler(processor, {
    consumerName: 'wager-consumer', backoff: { baseSeconds: 4, maxSeconds: 60 }, random: () => 1,
    log: (level, message, fields = {}) => logs.push({ level, message, fields }),
  });
  return { handler, calls, logs };
}

describe('WagerMessageHandler: classificação de erros', () => {
  test('usa o MESMO caso de uso, com o comando da mensagem e a origem (consumerName, messageId)', async () => {
    const { handler, calls } = handlerWith(async () => processed());
    await handler.handle(body, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toEqual({ consumerName: 'wager-consumer', messageId: 'msg-1' });
    expect(calls[0]?.command.correlationId).toBe('msg-1'); // o messageId é o correlationId dos eventos
    expect(calls[0]?.command.idempotencyKey).toBe('provider-a:ext-1');
    expect(calls[0]?.command.money.toString()).toBe('25.00');
  });

  test('NEGÓCIO: PROCESSED, replay, PENDING_REFERENCE, REJECTED e duplicata do inbox => ack', async () => {
    const outcomes: (ProcessWagerResult | DuplicateMessageResult)[] = [
      processed(), { ...processed(), idempotentReplay: true }, rejected(), pendingReference(), { duplicateMessage: true },
    ];
    for (const outcome of outcomes) {
      const { handler } = handlerWith(async () => outcome);
      expect(await handler.handle(body, 1)).toEqual({ action: 'ack' });
    }
  });

  test('TRANSITÓRIO: não confirma; devolve o atraso do backoff pelo ApproximateReceiveCount', async () => {
    const { handler } = handlerWith(async () => { throw new TransientInfrastructureError(new Error('boom')); });
    expect(await handler.handle(body, 1)).toEqual({ action: 'retry', delaySeconds: 4 });
    expect(await handler.handle(body, 3)).toEqual({ action: 'retry', delaySeconds: 16 });
    expect(await handler.handle(body, 9)).toEqual({ action: 'retry', delaySeconds: 60 });
  });

  test.each([
    ['corpo que não é JSON', 'xxx', 'MALFORMED_MESSAGE'],
    ['payload inválido', JSON.stringify({ messageId: 'm', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data: {} }), 'MALFORMED_MESSAGE'],
    ['type desconhecido', JSON.stringify({ messageId: 'm', type: 'Outra', occurredAt: '2026-07-29T15:00:00.000Z', data: {} }), 'UNKNOWN_MESSAGE_TYPE'],
  ])('PERMANENTE (%s) => DLQ sem chamar o caso de uso', async (_name, raw, reason) => {
    const { handler, calls } = handlerWith(async () => processed());
    expect(await handler.handle(raw, 1)).toEqual({ action: 'dead-letter', reason } as Disposition);
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['conflito de idempotência (nada foi gravado)', () => new IdempotencyConflictError(), 'IDEMPOTENCY_CONFLICT'],
    ['messageId reutilizado com outro conteúdo', () => new InboxPayloadConflictError('msg-1'), 'INBOX_PAYLOAD_CONFLICT'],
    ['wallet inexistente (nada foi gravado)', () => new WalletNotFoundError('w'), 'WALLET_NOT_FOUND'],
    ['bug (erro inesperado)', () => new Error('bug'), 'UNEXPECTED_ERROR'],
  ])('PERMANENTE (%s) => DLQ', async (_name, makeError, reason) => {
    const { handler } = handlerWith(async () => { throw makeError(); });
    expect(await handler.handle(body, 1)).toEqual({ action: 'dead-letter', reason } as Disposition);
  });

  test('logs usam o messageId como correlationId e nunca carregam o payload', async () => {
    const { handler, logs } = handlerWith(async () => { throw new Error('bug'); });
    await handler.handle(body, 2);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.fields['correlationId'] === 'msg-1')).toBe(true);
    const text = JSON.stringify(logs);
    for (const secret of ['25.00', 'provider-a:ext-1', '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1']) expect(text).not.toContain(secret);
  });
});
