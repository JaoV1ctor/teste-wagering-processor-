import { randomUUID as uuid } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection, LedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerEntryEntity } from '../../src/infrastructure/persistence/ledger-entry.entity';
import { LedgerEntryMapper } from '../../src/infrastructure/persistence/ledger-entry.mapper';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/wager-transaction.entity';
import { WagerTransactionMapper } from '../../src/infrastructure/persistence/wager-transaction.mapper';
import { WalletEntity } from '../../src/infrastructure/persistence/wallet.entity';
import { WalletMapper } from '../../src/infrastructure/persistence/wallet.mapper';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (v: string) => Money.fromString(v, 'BRL');

describe('WalletMapper', () => {
  const walletEntity = (balance: string) => Object.assign(new WalletEntity(), {
    id: uuid(), playerId: uuid(), currency: 'BRL', balance, version: 3, createdAt: now, updatedAt: now,
  });

  test('NUMERIC(19,2) vira Money sem perda, mesmo acima de Number.MAX_SAFE_INTEGER', () => {
    const entity = walletEntity('12345678901234567.89');
    const wallet = WalletMapper.toDomain(entity);
    expect(wallet).toBeInstanceOf(Wallet);
    expect(wallet.balance.cents).toBe(1234567890123456789n);
    expect(WalletMapper.toEntity(wallet).balance).toBe('12345678901234567.89');
  });

  test('ida e volta preserva todos os campos', () => {
    const entity = walletEntity('0.05');
    const back = WalletMapper.toEntity(WalletMapper.toDomain(entity));
    expect(back).toEqual(entity);
    expect(back).toBeInstanceOf(WalletEntity);
    expect(typeof back.balance).toBe('string');
  });
});

describe('LedgerEntryMapper', () => {
  test('ida e volta; direção e valores como string decimal', () => {
    const entry = LedgerEntry.create({
      id: uuid(), walletId: uuid(), transactionId: uuid(), direction: LedgerDirection.Debit,
      money: brl('80'), balanceBefore: brl('100'), balanceAfter: brl('20'), createdAt: now,
    });
    const entity = LedgerEntryMapper.toEntity(entry);
    expect(entity).toBeInstanceOf(LedgerEntryEntity);
    expect(entity.direction).toBe('DEBIT');
    expect([entity.amount, entity.balanceBefore, entity.balanceAfter]).toEqual(['80.00', '100.00', '20.00']);
    expect(entity.seq).toBeUndefined(); // atribuído pelo banco
    expect(LedgerEntryMapper.toDomain(entity)).toEqual(entry);
  });
});

describe('WagerTransactionMapper', () => {
  const create = (kind: WagerTransactionKind, ref?: string) => WagerTransaction.create({
    id: uuid(), providerId: 'prov', externalTransactionId: 'ext', idempotencyKey: 'prov:ext', payloadHash: 'a'.repeat(64),
    walletId: uuid(), playerId: uuid(), roundId: 'r', gameId: 'g', kind, money: brl('25'),
    ...(ref === undefined ? {} : { referenceExternalTransactionId: ref }), now,
  });

  test('PENDING recém-criada: opcionais viram null no banco e voltam como undefined', () => {
    const tx = create(WagerTransactionKind.Bet);
    const entity = WagerTransactionMapper.toEntity(tx);
    expect(entity).toBeInstanceOf(WagerTransactionEntity);
    expect(entity.amount).toBe('25.00');
    expect(entity.failureCode).toBeNull();
    expect(entity.observedBalance).toBeNull();
    expect(entity.processedAt).toBeNull();
    expect(WagerTransactionMapper.toDomain(entity).toState()).toEqual(tx.toState());
  });

  test('PROCESSED com referência', () => {
    const tx = create(WagerTransactionKind.Refund, 'ext-bet');
    tx.markProcessed({ observedBalance: brl('125.50'), at: now, referenceTransactionId: uuid() });
    const entity = WagerTransactionMapper.toEntity(tx);
    expect(entity.status).toBe('PROCESSED');
    expect(entity.observedBalance).toBe('125.50');
    expect(WagerTransactionMapper.toDomain(entity).toState()).toEqual(tx.toState());
  });

  test('REJECTED com failureCode', () => {
    const tx = create(WagerTransactionKind.Bet);
    tx.reject(FailureCode.InsufficientBalance, brl('10'), now);
    const entity = WagerTransactionMapper.toEntity(tx);
    expect(entity.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(WagerTransactionMapper.toDomain(entity).toState()).toEqual(tx.toState());
  });
});
