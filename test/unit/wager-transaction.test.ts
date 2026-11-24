import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:10Z');
const brl = (v: string) => Money.fromString(v, 'BRL');
const K = WagerTransactionKind;
const S = WagerTransactionStatus;

function make(kind: WagerTransactionKind, referenceExternalTransactionId?: string, id = 'tx1') {
  return WagerTransaction.create({
    id, providerId: 'prov', externalTransactionId: `ext-${id}`, idempotencyKey: `prov:ext-${id}`, payloadHash: 'h'.repeat(64),
    walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1', kind, money: brl('25'),
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }), now: t0,
  });
}
const processed = (tx: WagerTransaction) => tx.markProcessed({ observedBalance: brl('75'), at: t1 });

describe('create: referência por kind (espelha o CHECK do schema)', () => {
  test('nasce PENDING', () => {
    const tx = make(K.Bet);
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.attempts).toBe(0);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => make(K.Refund)).toThrow(InvalidWagerTransactionError);
    expect(() => make(K.Rollback)).toThrow(InvalidWagerTransactionError);
    expect(make(K.Refund, 'ext-bet').requiresReference()).toBe(true);
    expect(make(K.Rollback, 'ext-bet').requiresReference()).toBe(true);
  });

  test('BET e OPENING não aceitam referência', () => {
    expect(() => make(K.Bet, 'x')).toThrow(InvalidWagerTransactionError);
    expect(() => make(K.Opening, 'x')).toThrow(InvalidWagerTransactionError);
  });

  test('uma transação não pode referenciar a si mesma (espelha wt_not_self_reference)', () => {
    expect(() => WagerTransaction.create({
      id: 'x', providerId: 'p', externalTransactionId: 'mesmo', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w', playerId: 'p',
      roundId: 'r', gameId: 'g', kind: K.Refund, money: brl('1'), referenceExternalTransactionId: 'mesmo', now: t0,
    })).toThrow(InvalidWagerTransactionError);
  });

  test('WIN e LOSS aceitam referência opcional', () => {
    expect(make(K.Win).requiresReference()).toBe(false);
    expect(make(K.Win, 'ext-bet').referenceExternalTransactionId).toBe('ext-bet');
    expect(make(K.Loss).referenceExternalTransactionId).toBeUndefined();
  });

  test('valor deve ser > 0', () => {
    expect(() => WagerTransaction.create({
      id: 'x', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w', playerId: 'p',
      roundId: 'r', gameId: 'g', kind: K.Bet, money: brl('0'), now: t0,
    })).toThrow(InvalidWagerTransactionError);
  });
});

describe('máquina de estados (SPEC §4)', () => {
  test('PENDING -> PROCESSED guarda saldo observado, data e referência', () => {
    const tx = make(K.Refund, 'ext-bet');
    tx.markProcessed({ observedBalance: brl('125'), at: t1, referenceTransactionId: 'bet-id' });
    expect(tx.status).toBe(S.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(t1);
    expect(tx.observedBalance?.toString()).toBe('125.00');
    expect(tx.referenceTransactionId).toBe('bet-id');
  });

  test('reversão só pode ser processada com referenceTransactionId', () => {
    expect(() => processed(make(K.Refund, 'ext-bet'))).toThrow(InvalidWagerTransactionError);
    expect(() => processed(make(K.Rollback, 'ext-bet'))).toThrow(InvalidWagerTransactionError);
  });

  test('PENDING -> REJECTED guarda failureCode e saldo observado', () => {
    const tx = make(K.Bet);
    tx.reject(FailureCode.InsufficientBalance, brl('10'), t1);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(tx.observedBalance?.toString()).toBe('10.00');
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> FAILED guarda failureCode', () => {
    const tx = make(K.Bet);
    tx.fail(FailureCode.InternalPermanentError, t1);
    expect(tx.status).toBe(S.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalPermanentError);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> PENDING_REFERENCE conta tentativa e agenda a próxima', () => {
    const tx = make(K.Refund, 'ext-bet');
    const next = new Date('2026-01-01T00:00:20Z');
    tx.markPendingReference(next, t1);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(next);
    expect(tx.isTerminal()).toBe(false);
  });

  test('PENDING_REFERENCE reprocessada mantém o estado e soma tentativas', () => {
    const tx = make(K.Refund, 'ext-bet');
    tx.markPendingReference(t1, t1);
    tx.markPendingReference(new Date('2026-01-01T00:01:00Z'), t1);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(2);
  });

  test('PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED', () => {
    const toProcessed = make(K.Refund, 'ext-bet', 'a');
    toProcessed.markPendingReference(t1, t1);
    toProcessed.markProcessed({ observedBalance: brl('1'), at: t1, referenceTransactionId: 'bet' });
    expect(toProcessed.status).toBe(S.Processed);

    const toRejected = make(K.Refund, 'ext-bet', 'b');
    toRejected.markPendingReference(t1, t1);
    toRejected.reject(FailureCode.ReferenceNotFound, brl('1'), t1);
    expect(toRejected.status).toBe(S.Rejected);

    const toFailed = make(K.Refund, 'ext-bet', 'c');
    toFailed.markPendingReference(t1, t1);
    toFailed.fail(FailureCode.InternalPermanentError, t1);
    expect(toFailed.status).toBe(S.Failed);
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => processed(tx)],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientBalance, brl('1'), t1)],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InternalPermanentError, t1)],
  ])('estado terminal %s não aceita nenhuma transição', (_name, toTerminal) => {
    const tx = make(K.Bet);
    toTerminal(tx);
    const before = tx.status;
    expect(() => processed(tx)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientBalance, brl('1'), t1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalPermanentError, t1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(t1, t1)).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(before);
  });

  test('reject exige código de rejeição e fail exige código de falha permanente', () => {
    expect(() => make(K.Bet).reject(FailureCode.InternalPermanentError, brl('1'), t1)).toThrow(InvalidWagerTransactionError);
    expect(() => make(K.Bet).fail(FailureCode.InsufficientBalance, t1)).toThrow(InvalidWagerTransactionError);
  });
});

describe('PENDING_REFERENCE nunca volta a PENDING (SPEC §4; o trigger do banco repete a regra)', () => {
  const pending = () => {
    const tx = make(K.Refund, 'ext-bet');
    tx.markPendingReference(t1, t0);
    return tx;
  };

  test('nenhuma transição do domínio, a partir de PENDING_REFERENCE, devolve PENDING', () => {
    const transitions: [string, (tx: WagerTransaction) => void][] = [
      ['markPendingReference', (tx) => tx.markPendingReference(t1, t1)],
      ['markProcessed', (tx) => tx.markProcessed({ observedBalance: brl('1'), at: t1, referenceTransactionId: 'bet' })],
      ['reject', (tx) => tx.reject(FailureCode.ReferenceNotFound, brl('1'), t1)],
      ['fail', (tx) => tx.fail(FailureCode.InternalPermanentError, t1)],
    ];
    for (const [name, transition] of transitions) {
      const tx = pending();
      transition(tx);
      expect(tx.status, name).not.toBe(S.Pending);
    }
  });

  test('o único jeito de ter PENDING é nascer (create); reidratar PENDING_REFERENCE preserva o estado', () => {
    expect(make(K.Refund, 'ext-bet').status).toBe(S.Pending);
    const copy = WagerTransaction.rehydrate(pending().toState());
    expect(copy.status).toBe(S.PendingReference);
    copy.markPendingReference(t1, t1);
    expect(copy.status).toBe(S.PendingReference);
    expect(copy.attempts).toBe(2);
  });

  test('não existe API pública que reponha PENDING', () => {
    const api = Object.getOwnPropertyNames(WagerTransaction.prototype).filter((name) => /pending$/i.test(name) && name !== 'markPendingReference');
    expect(api).toEqual([]);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance: false só para LOSS', () => {
    expect(make(K.Loss).affectsBalance()).toBe(false);
    for (const kind of [K.Bet, K.Win, K.Opening]) expect(make(kind).affectsBalance()).toBe(true);
    expect(make(K.Refund, 'x').affectsBalance()).toBe(true);
  });

  test('matchesPayload compara o hash', () => {
    const tx = make(K.Bet);
    expect(tx.matchesPayload('h'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('x'.repeat(64))).toBe(false);
  });

  test('ledgerDirectionFor: BET debita, WIN e OPENING creditam', () => {
    expect(make(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Opening).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: LOSS não move saldo', () => {
    expect(() => make(K.Loss).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('ledgerDirectionFor: reversão é o inverso da referência', () => {
    const bet = make(K.Bet, undefined, 'bet');
    const win = make(K.Win, undefined, 'win');
    const refund = make(K.Refund, 'ext-bet', 'rf');
    expect(make(K.Refund, 'ext-bet').ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(make(K.Rollback, 'ext-bet').ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(make(K.Rollback, 'ext-win').ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(make(K.Rollback, 'ext-rf').ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ledgerDirectionFor: reversão exige referência e tipo válido (REFUND só de BET)', () => {
    expect(() => make(K.Refund, 'x').ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => make(K.Refund, 'x').ledgerDirectionFor(make(K.Win))).toThrow(InvalidWagerTransactionError);
    expect(() => make(K.Rollback, 'x').ledgerDirectionFor(make(K.Loss))).toThrow(InvalidWagerTransactionError);
  });
});

describe('rehydrate', () => {
  test('reconstrói qualquer estado sem revalidar transições', () => {
    const tx = make(K.Bet);
    processed(tx);
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy).toBeInstanceOf(WagerTransaction);
    expect(copy.toState()).toEqual(tx.toState());
    expect(copy.status).toBe(S.Processed);
    expect(() => processed(copy)).toThrow(InvalidTransactionStateError);
  });
});
