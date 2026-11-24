// REFUND/ROLLBACK e referências (README §7, SPEC §3 e §5.1). Domínio puro: sem banco.
import { describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { REFERENCE_RETRY } from '../../src/domain/reference-retry-policy';
import { settleWager } from '../../src/domain/wager-settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const K = WagerTransactionKind;
const S = WagerTransactionStatus;
const at = new Date('2026-01-01T12:00:00.000Z');
const money = (amount: string, currency = 'BRL') => Money.fromString(amount, currency);

function walletWith(balance: string): Wallet {
  return Wallet.create({ id: uuid(), playerId: uuid(), initialBalance: money(balance), openingTransactionId: uuid(), openingEntryId: uuid(), now: at }).wallet;
}

interface Overrides { playerId?: string; walletId?: string; roundId?: string; amount?: string; currency?: string; reference?: string }

function make(wallet: Wallet, kind: WagerTransactionKind, o: Overrides = {}): WagerTransaction {
  return WagerTransaction.create({
    id: uuid(), providerId: 'provider-a', externalTransactionId: `ext-${uuid()}`, idempotencyKey: `key-${uuid()}`, payloadHash: 'a'.repeat(64),
    walletId: o.walletId ?? wallet.id, playerId: o.playerId ?? wallet.playerId, roundId: o.roundId ?? 'round-1', gameId: 'game-1', kind,
    money: money(o.amount ?? '30.00', o.currency ?? 'BRL'), now: at, ...(o.reference === undefined ? {} : { referenceExternalTransactionId: o.reference }),
  });
}

/** Transação já resolvida, como o banco a devolveria: serve de referência. */
function resolved(wallet: Wallet, kind: WagerTransactionKind, status: WagerTransactionStatus = S.Processed, o: Overrides = {}): WagerTransaction {
  const tx = make(wallet, kind, o);
  if (status === S.Processed) tx.markProcessed({ observedBalance: wallet.balance, at, ...(tx.requiresReference() ? { referenceTransactionId: uuid() } : {}) });
  else if (status === S.Rejected) tx.reject(FailureCode.InsufficientBalance, wallet.balance, at);
  else if (status === S.Failed) tx.fail(FailureCode.InternalPermanentError, at);
  else if (status === S.PendingReference) tx.markPendingReference(at, at);
  return tx;
}

const reversal = (wallet: Wallet, kind: WagerTransactionKind, reference: WagerTransaction, o: Overrides = {}) =>
  make(wallet, kind, { amount: reference.money.toString(), reference: reference.externalTransactionId, ...o });

interface Context { reference?: WagerTransaction | undefined; referenceAlreadyReversed?: boolean }
const settle = (wallet: Wallet, tx: WagerTransaction, context: Context = {}) => settleWager(wallet, tx, { entryId: uuid(), at, random: () => 0, ...context });

describe('efeito no saldo', () => {
  test('REFUND de BET: crédito do mesmo valor; PROCESSED com a referência e o saldo observado', () => {
    const wallet = walletWith('70.00');
    const bet = resolved(wallet, K.Bet);
    const refund = reversal(wallet, K.Refund, bet);
    const entry = settle(wallet, refund, { reference: bet });

    expect(entry).toMatchObject({ direction: LedgerDirection.Credit, transactionId: refund.id });
    expect(entry?.balanceBefore.toString()).toBe('70.00');
    expect(entry?.balanceAfter.toString()).toBe('100.00');
    expect(wallet.version).toBe(2);
    expect(refund.status).toBe(S.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(refund.observedBalance?.toString()).toBe('100.00');
  });

  test.each([
    [K.Bet, LedgerDirection.Credit, '100.00'],
    [K.Win, LedgerDirection.Debit, '40.00'],
    [K.Refund, LedgerDirection.Debit, '40.00'],
  ])('ROLLBACK de %s é o inverso da referência (%s)', (referenceKind, direction, balanceAfter) => {
    const wallet = walletWith('70.00');
    const reference = resolved(wallet, referenceKind, S.Processed, referenceKind === K.Refund ? { reference: 'ext-bet' } : {});
    const rollback = reversal(wallet, K.Rollback, reference);
    const entry = settle(wallet, rollback, { reference });

    expect(entry?.direction).toBe(direction);
    expect(wallet.balance.toString()).toBe(balanceAfter);
    expect(rollback.status).toBe(S.Processed);
  });

  test('WIN que referencia a BET credita e grava a referência; LOSS referenciando não move saldo', () => {
    const wallet = walletWith('70.00');
    const bet = resolved(wallet, K.Bet);
    const win = make(wallet, K.Win, { amount: '80.00', reference: bet.externalTransactionId });
    expect(settle(wallet, win, { reference: bet })?.direction).toBe(LedgerDirection.Credit);
    expect(win.referenceTransactionId).toBe(bet.id);

    const loss = make(wallet, K.Loss, { reference: bet.externalTransactionId });
    expect(settle(wallet, loss, { reference: bet })).toBeUndefined();
    expect(loss.status).toBe(S.Processed);
    expect(loss.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe('150.00');
  });
});

describe('rejeições: saldo, version e ledger intactos; saldo observado gravado', () => {
  interface Scenario { wallet: Wallet; tx: WagerTransaction; reference?: WagerTransaction; reversed?: boolean }
  const rejects = (name: string, code: FailureCode, scenario: () => Scenario) =>
    test(`${name}: ${code}`, () => {
      const { wallet, tx, reference, reversed } = scenario();
      const before = wallet.balance.toString();
      const entry = settle(wallet, tx, { reference, referenceAlreadyReversed: reversed === true });
      expect(entry).toBeUndefined();
      expect(tx.status).toBe(S.Rejected);
      expect(tx.failureCode).toBe(code);
      expect(tx.observedBalance?.toString()).toBe(before);
      expect(wallet.balance.toString()).toBe(before);
      expect(wallet.version).toBe(1);
    });

  const base = () => {
    const wallet = walletWith('70.00');
    return { wallet, bet: resolved(wallet, K.Bet) };
  };

  rejects('referência de outra wallet', FailureCode.ReferenceMismatch, () => {
    const { wallet } = base();
    const foreign = resolved(wallet, K.Bet, S.Processed, { walletId: uuid() });
    return { wallet, tx: reversal(wallet, K.Refund, foreign), reference: foreign };
  });
  rejects('referência de outro player', FailureCode.ReferenceMismatch, () => {
    const { wallet } = base();
    const foreign = resolved(wallet, K.Bet, S.Processed, { playerId: uuid() });
    return { wallet, tx: reversal(wallet, K.Refund, foreign), reference: foreign };
  });
  rejects('referência de outra rodada', FailureCode.ReferenceMismatch, () => {
    const { wallet, bet } = base();
    return { wallet, tx: reversal(wallet, K.Refund, bet, { roundId: 'round-2' }), reference: bet };
  });
  rejects('referência em outra moeda', FailureCode.ReferenceMismatch, () => {
    const { wallet } = base();
    const usd = resolved(wallet, K.Bet, S.Processed, { currency: 'USD' });
    return { wallet, tx: reversal(wallet, K.Refund, usd, { currency: 'BRL' }), reference: usd };
  });
  rejects('REFUND de WIN', FailureCode.InvalidReferenceKind, () => {
    const { wallet } = base();
    const win = resolved(wallet, K.Win);
    return { wallet, tx: reversal(wallet, K.Refund, win), reference: win };
  });
  rejects('REFUND de LOSS', FailureCode.InvalidReferenceKind, () => {
    const { wallet } = base();
    const loss = resolved(wallet, K.Loss);
    return { wallet, tx: reversal(wallet, K.Refund, loss), reference: loss };
  });
  rejects('ROLLBACK de ROLLBACK', FailureCode.InvalidReferenceKind, () => {
    const { wallet } = base();
    const rollback = resolved(wallet, K.Rollback, S.Processed, { reference: 'ext-bet' });
    return { wallet, tx: reversal(wallet, K.Rollback, rollback), reference: rollback };
  });
  rejects('WIN que referencia outra WIN', FailureCode.InvalidReferenceKind, () => {
    const { wallet } = base();
    const win = resolved(wallet, K.Win);
    return { wallet, tx: make(wallet, K.Win, { reference: win.externalTransactionId }), reference: win };
  });
  rejects('referência REJECTED', FailureCode.ReferenceNotProcessed, () => {
    const { wallet } = base();
    const bet = resolved(wallet, K.Bet, S.Rejected);
    return { wallet, tx: reversal(wallet, K.Refund, bet), reference: bet };
  });
  rejects('referência FAILED', FailureCode.ReferenceNotProcessed, () => {
    const { wallet } = base();
    const bet = resolved(wallet, K.Bet, S.Failed);
    return { wallet, tx: reversal(wallet, K.Refund, bet), reference: bet };
  });
  rejects('valor menor que o da referência', FailureCode.AmountMismatch, () => {
    const { wallet, bet } = base();
    return { wallet, tx: reversal(wallet, K.Refund, bet, { amount: '29.99' }), reference: bet };
  });
  rejects('valor maior que o da referência', FailureCode.AmountMismatch, () => {
    const { wallet, bet } = base();
    return { wallet, tx: reversal(wallet, K.Rollback, bet, { amount: '30.01' }), reference: bet };
  });
  rejects('referência já revertida', FailureCode.AlreadyReversed, () => {
    const { wallet, bet } = base();
    return { wallet, tx: reversal(wallet, K.Refund, bet), reference: bet, reversed: true };
  });
  rejects('ROLLBACK de WIN sem saldo para debitar', FailureCode.ReversalWouldOverdraw, () => {
    const wallet = walletWith('10.00');
    const win = resolved(wallet, K.Win, S.Processed, { amount: '50.00' });
    return { wallet, tx: reversal(wallet, K.Rollback, win), reference: win };
  });
  rejects('REFUND que estoura NUMERIC(19,2)', FailureCode.BalanceLimitExceeded, () => {
    const wallet = walletWith('99999999999999999.00');
    const bet = resolved(wallet, K.Bet);
    return { wallet, tx: reversal(wallet, K.Refund, bet), reference: bet };
  });

  test('ROLLBACK que zera a wallet exatamente é permitido (não é overdraw)', () => {
    const wallet = walletWith('50.00');
    const win = resolved(wallet, K.Win, S.Processed, { amount: '50.00' });
    settle(wallet, reversal(wallet, K.Rollback, win), { reference: win });
    expect(wallet.balance.toString()).toBe('0.00');
  });
});

describe('precedência das regras (a primeira violação decide, de forma determinística)', () => {
  test('player e moeda da wallet vêm antes de qualquer regra de referência', () => {
    const wallet = walletWith('70.00');
    const win = resolved(wallet, K.Win); // tipo inválido para REFUND
    const tx = reversal(wallet, K.Refund, win, { playerId: uuid() });
    settle(wallet, tx, { reference: win });
    expect(tx.failureCode).toBe(FailureCode.PlayerMismatch);
  });

  test('MISMATCH antes de KIND', () => {
    const wallet = walletWith('70.00');
    const win = resolved(wallet, K.Win);
    const tx = reversal(wallet, K.Refund, win, { roundId: 'round-2' });
    settle(wallet, tx, { reference: win });
    expect(tx.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('KIND antes de NOT_PROCESSED', () => {
    const wallet = walletWith('70.00');
    const rejectedWin = resolved(wallet, K.Win, S.Rejected);
    const tx = reversal(wallet, K.Refund, rejectedWin);
    settle(wallet, tx, { reference: rejectedWin });
    expect(tx.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('NOT_PROCESSED antes de AMOUNT_MISMATCH, e AMOUNT_MISMATCH antes de ALREADY_REVERSED', () => {
    const wallet = walletWith('70.00');
    const rejectedBet = resolved(wallet, K.Bet, S.Rejected);
    const a = reversal(wallet, K.Refund, rejectedBet, { amount: '1.00' });
    settle(wallet, a, { reference: rejectedBet });
    expect(a.failureCode).toBe(FailureCode.ReferenceNotProcessed);

    const bet = resolved(wallet, K.Bet);
    const b = reversal(wallet, K.Refund, bet, { amount: '1.00' });
    settle(wallet, b, { reference: bet, referenceAlreadyReversed: true });
    expect(b.failureCode).toBe(FailureCode.AmountMismatch);
  });
});

describe('referência ausente => PENDING_REFERENCE (README §7 regra 8 e §7.1)', () => {
  test('sem referência: fica PENDING_REFERENCE, sem tocar a wallet, 1ª tentativa agendada para +1s', () => {
    const wallet = walletWith('70.00');
    const tx = make(wallet, K.Refund, { reference: 'ext-bet' });
    const entry = settle(wallet, tx);

    expect(entry).toBeUndefined();
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(new Date(at.getTime() + 1000));
    expect(tx.observedBalance).toBeUndefined();
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(1);
  });

  test('o jitter soma ao agendamento (random injetado)', () => {
    const wallet = walletWith('70.00');
    const tx = make(wallet, K.Win, { reference: 'ext-bet' });
    settleWager(wallet, tx, { entryId: uuid(), at, random: () => 0.5 });
    expect(tx.nextAttemptAt).toEqual(new Date(at.getTime() + 1250));
  });

  test('referência que também está PENDING_REFERENCE: espera, não rejeita', () => {
    const wallet = walletWith('70.00');
    const pendingWin = resolved(wallet, K.Win, S.PendingReference, { reference: 'ext-bet' });
    const rollback = reversal(wallet, K.Rollback, pendingWin);
    settle(wallet, rollback, { reference: pendingWin });
    expect(rollback.status).toBe(S.PendingReference);
  });

  test('reprocessar uma PENDING_REFERENCE ainda sem referência soma tentativa e recua o próximo agendamento (backoff)', () => {
    const wallet = walletWith('70.00');
    const tx = make(wallet, K.Refund, { reference: 'ext-bet' });
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      settle(wallet, tx);
      waits.push((tx.nextAttemptAt as Date).getTime() - at.getTime());
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
    expect(tx.attempts).toBe(7);
    expect(tx.status).toBe(S.PendingReference);
  });

  test('avaliação inicial + 8 reprocessamentos sem referência: a 9ª avaliação é REJECTED/REFERENCE_NOT_FOUND, com o saldo observado', () => {
    const wallet = walletWith('70.00');
    const tx = make(wallet, K.Refund, { reference: 'ext-bet' });
    for (let i = 0; i < REFERENCE_RETRY.maxReprocessAttempts; i += 1) {
      settle(wallet, tx);
      expect(tx.status).toBe(S.PendingReference);
    }
    expect(tx.attempts).toBe(REFERENCE_RETRY.maxReprocessAttempts);

    settle(wallet, tx);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.observedBalance?.toString()).toBe('70.00');
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(1);
  });

  test('a referência que aparece no último reprocessamento ainda resolve (não rejeita por limite)', () => {
    const wallet = walletWith('70.00');
    const bet = resolved(wallet, K.Bet);
    const tx = reversal(wallet, K.Refund, bet);
    for (let i = 0; i < REFERENCE_RETRY.maxReprocessAttempts; i += 1) settle(wallet, tx);
    settle(wallet, tx, { reference: bet });
    expect(tx.status).toBe(S.Processed);
  });

  test('player divergente não espera: rejeita já, mesmo sem referência', () => {
    const wallet = walletWith('70.00');
    const tx = make(wallet, K.Refund, { reference: 'ext-bet', playerId: uuid() });
    settle(wallet, tx);
    expect(tx.failureCode).toBe(FailureCode.PlayerMismatch);
  });
});
