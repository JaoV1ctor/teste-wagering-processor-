// Borda HTTP de /wagering: validação do corpo/cabeçalho e mapeamento status de negócio -> HTTP.
import { describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { CorrelationIdHeader, httpStatusFor, IdempotencyKeyHeader, SubmitTransactionBody, toSubmitResponse, toTransactionResponse } from '../../src/interface/http/wagering.dto';

const valid = () => ({
  providerId: 'provider-a', externalTransactionId: 'transaction-123', playerId: uuid(), walletId: uuid(), roundId: 'round-987',
  gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
});

const issues = (input: unknown) => {
  const parsed = SubmitTransactionBody.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
};

describe('SubmitTransactionBody', () => {
  test.each(['BET', 'WIN', 'LOSS'])('aceita %s e converte o valor para Money', (kind) => {
    const parsed = SubmitTransactionBody.parse({ ...valid(), kind });
    expect(String(parsed.kind)).toBe(kind);
    expect(parsed.money).toBeInstanceOf(Money);
    expect(parsed.money.toString()).toBe('25.00');
  });

  test.each([
    ['OPENING (interno)', { kind: 'OPENING' }],
    ['REFUND sem referenceExternalTransactionId (regra 1)', { kind: 'REFUND' }],
    ['ROLLBACK sem referenceExternalTransactionId (regra 1)', { kind: 'ROLLBACK' }],
    ['BET com referenceExternalTransactionId', { referenceExternalTransactionId: 'x' }],
    ['referência para a própria transação', { kind: 'REFUND', referenceExternalTransactionId: 'transaction-123' }],
    ['referenceExternalTransactionId vazio', { kind: 'WIN', referenceExternalTransactionId: '' }],
    ['referenceExternalTransactionId que não é string', { kind: 'WIN', referenceExternalTransactionId: 7 }],
    ['tipo desconhecido', { kind: 'JACKPOT' }],
    ['valor 0.00 (amount > 0)', { money: { amount: '0.00', currency: 'BRL' } }],
    ['valor negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['3 casas decimais', { money: { amount: '10.005', currency: 'BRL' } }],
    ['valor como number JSON', { money: { amount: 10.5, currency: 'BRL' } }],
    ['moeda minúscula', { money: { amount: '10.00', currency: 'brl' } }],
    ['playerId que não é uuid', { playerId: 'p1' }],
    ['walletId que não é uuid', { walletId: 'w1' }],
    ['campo desconhecido', { surprise: true }],
    ['providerId vazio', { providerId: '' }],
    ['externalTransactionId ausente', { externalTransactionId: undefined }],
  ])('rejeita %s', (_name, change) => {
    expect(issues({ ...valid(), ...change }).length).toBeGreaterThan(0);
  });

  test.each(['REFUND', 'ROLLBACK'])('%s com referenceExternalTransactionId é aceita e preservada', (kind) => {
    const parsed = SubmitTransactionBody.parse({ ...valid(), kind, referenceExternalTransactionId: 'bet-1' });
    expect(parsed.referenceExternalTransactionId).toBe('bet-1');
  });

  test.each(['WIN', 'LOSS'])('%s aceita referência opcional, com ou sem ela', (kind) => {
    expect(SubmitTransactionBody.parse({ ...valid(), kind, referenceExternalTransactionId: 'bet-1' }).referenceExternalTransactionId).toBe('bet-1');
    expect(SubmitTransactionBody.parse({ ...valid(), kind }).referenceExternalTransactionId).toBeUndefined();
  });

  test('o erro de referência obrigatória aponta o campo', () => {
    const found = issues({ ...valid(), kind: 'REFUND' });
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('referenceExternalTransactionId');
  });
});

describe('IdempotencyKeyHeader', () => {
  test('aceita a chave e preserva o valor', () => {
    expect(IdempotencyKeyHeader.parse('provider-a:transaction-123')).toBe('provider-a:transaction-123');
  });

  test.each([undefined, '', '   ', 'x'.repeat(256)])('rejeita %p', (value) => {
    expect(IdempotencyKeyHeader.safeParse(value).success).toBe(false);
  });
});

describe('CorrelationIdHeader', () => {
  test('é opcional: ausente é aceito e o valor presente é preservado', () => {
    expect(CorrelationIdHeader.parse(undefined)).toBeUndefined();
    expect(CorrelationIdHeader.parse('corr-123')).toBe('corr-123');
  });

  test.each(['', '   ', 'x'.repeat(129)])('rejeita %p', (value) => {
    expect(CorrelationIdHeader.safeParse(value).success).toBe(false);
  });
});

describe('httpStatusFor', () => {
  test.each([
    [WagerTransactionStatus.Processed, 201],
    [WagerTransactionStatus.Rejected, 422],
    [WagerTransactionStatus.PendingReference, 202],
    [WagerTransactionStatus.Failed, 422],
  ])('%s -> %i', (status, http) => {
    expect(httpStatusFor(status)).toBe(http);
  });
});

function finished(outcome: 'processed' | 'rejected'): WagerTransaction {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const tx = WagerTransaction.create({
    id: uuid(), providerId: 'provider-a', externalTransactionId: 'ext-1', idempotencyKey: 'provider-a:ext-1', payloadHash: 'a'.repeat(64),
    walletId: uuid(), playerId: uuid(), roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: Money.fromString('25.00', 'BRL'), now,
  });
  if (outcome === 'processed') tx.markProcessed({ observedBalance: Money.fromString('975.00', 'BRL'), at: now });
  else tx.reject(FailureCode.InsufficientBalance, Money.fromString('10.00', 'BRL'), now);
  return tx;
}

describe('respostas', () => {
  test('POST processada: exatamente transactionId, status, balance e idempotentReplay (sem failureCode)', () => {
    const tx = finished('processed');
    expect(toSubmitResponse({ transaction: tx, idempotentReplay: false })).toEqual({
      transactionId: tx.id, status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false,
    });
  });

  test('POST rejeitada: acrescenta failureCode e devolve o saldo da época', () => {
    const tx = finished('rejected');
    expect(toSubmitResponse({ transaction: tx, idempotentReplay: true })).toEqual({
      transactionId: tx.id, status: 'REJECTED', balance: { amount: '10.00', currency: 'BRL' }, idempotentReplay: true, failureCode: 'INSUFFICIENT_BALANCE',
    });
  });

  test('GET: representação completa da transação', () => {
    const tx = finished('processed');
    expect(toTransactionResponse(tx)).toEqual({
      transactionId: tx.id, providerId: 'provider-a', externalTransactionId: 'ext-1', walletId: tx.walletId, playerId: tx.playerId,
      roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, status: 'PROCESSED', failureCode: null,
      balance: { amount: '975.00', currency: 'BRL' }, createdAt: '2026-01-01T00:00:00.000Z', processedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
