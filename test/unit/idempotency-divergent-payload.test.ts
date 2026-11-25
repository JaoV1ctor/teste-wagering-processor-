// A decisão "replay ou conflito" para uma chave já conhecida. Unidade: o único dublê é a porta de leitura, que devolve a transação já
// gravada; abrir transação é erro. A mesma regra contra o Postgres real está em test/integration/process-wager-transaction.test.ts.
import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import { computePayloadHash } from '../../src/application/payload-hash';
import type { Repositories, UnitOfWork } from '../../src/application/ports';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.fromString(amount, 'BRL');
const command: ProcessWagerCommand = {
  idempotencyKey: 'provider-a:ext-1', providerId: 'provider-a', externalTransactionId: 'ext-1', playerId: 'player-1', walletId: 'wallet-1',
  roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Win, money: brl('10.00'), referenceExternalTransactionId: 'ext-bet',
};

/** A transação que o `command` teria deixado gravada, já PROCESSED. */
function stored(): WagerTransaction {
  const at = new Date('2026-01-01T00:00:00Z');
  const { providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money } = command;
  const business = { providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind };
  const transaction = WagerTransaction.create({
    ...business, id: 'tx-1', idempotencyKey: command.idempotencyKey, money, referenceExternalTransactionId: 'ext-bet', now: at,
    payloadHash: computePayloadHash({ ...business, money: money.toProps(), referenceExternalTransactionId: 'ext-bet' }),
  });
  transaction.markProcessed({ observedBalance: brl('110.00'), at });
  return transaction;
}

function useCaseKnowing(transaction: WagerTransaction): ProcessWagerTransactionUseCase {
  const uow: UnitOfWork = {
    read: (work) =>
      work({
        transactions: { findByIdempotencyKey: async (key: string) => (key === transaction.idempotencyKey ? transaction : undefined) },
      } as unknown as Repositories),
    run: () => Promise.reject(new Error('uma chave conhecida, entrando por HTTP, não pode abrir transação')),
  };
  return new ProcessWagerTransactionUseCase(uow);
}

describe('mesma Idempotency-Key', () => {
  test('mesmo payload: replay da transação gravada, sem abrir transação', async () => {
    const transaction = stored();

    const result = await useCaseKnowing(transaction).execute(command);

    expect(result).toEqual({ transaction, idempotentReplay: true });
  });

  test('o correlationId não é payload: continua replay', async () => {
    const result = await useCaseKnowing(stored()).execute({ ...command, correlationId: 'outro' });

    expect(result.idempotentReplay).toBe(true);
  });

  test.each<[string, Partial<ProcessWagerCommand>]>([
    ['valor', { money: brl('10.01') }],
    ['moeda', { money: Money.fromString('10.00', 'USD') }],
    ['tipo', { kind: WagerTransactionKind.Loss }],
    ['provedor', { providerId: 'provider-b' }],
    ['id externo', { externalTransactionId: 'ext-2' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['rodada', { roundId: 'round-2' }],
    ['jogo', { gameId: 'game-2' }],
    ['referência', { referenceExternalTransactionId: 'ext-outra' }],
  ])('payload divergente (%s): IdempotencyConflictError, nunca replay', async (_name, change) => {
    await expect(useCaseKnowing(stored()).execute({ ...command, ...change })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
