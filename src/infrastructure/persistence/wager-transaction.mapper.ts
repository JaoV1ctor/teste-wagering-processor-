import type { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import { WagerTransactionEntity } from './wager-transaction.entity';

const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

export const WagerTransactionMapper = {
  /** `kind`, `status` e `failureCode` são garantidos pelos CHECKs do schema. */
  toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const money = (value: string) => Money.fromString(value, entity.currency);
    return WagerTransaction.rehydrate({
      id: entity.id, providerId: entity.providerId, externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey, payloadHash: entity.payloadHash, walletId: entity.walletId,
      playerId: entity.playerId, roundId: entity.roundId, gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind, money: money(entity.amount),
      referenceExternalTransactionId: orUndefined(entity.referenceExternalTransactionId),
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(entity.referenceTransactionId),
      failureCode: orUndefined(entity.failureCode) as FailureCode | undefined,
      observedBalance: entity.observedBalance === null ? undefined : money(entity.observedBalance),
      attempts: entity.attempts, nextAttemptAt: orUndefined(entity.nextAttemptAt),
      createdAt: entity.createdAt, updatedAt: entity.updatedAt, processedAt: orUndefined(entity.processedAt),
    });
  },

  toEntity(transaction: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.amount = transaction.money.toString();
    entity.currency = transaction.money.currency;
    entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
    entity.status = transaction.status;
    entity.failureCode = transaction.failureCode ?? null;
    entity.observedBalance = transaction.observedBalance?.toString() ?? null;
    entity.attempts = transaction.attempts;
    entity.nextAttemptAt = transaction.nextAttemptAt ?? null;
    entity.createdAt = transaction.createdAt;
    entity.updatedAt = transaction.updatedAt;
    entity.processedAt = transaction.processedAt ?? null;
    return entity;
  },
};
