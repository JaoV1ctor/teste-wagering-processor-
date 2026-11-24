import { LedgerDirection, LedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { LedgerEntryEntity } from './ledger-entry.entity';

export const LedgerEntryMapper = {
  toDomain(entity: LedgerEntryEntity): LedgerEntry {
    const money = (value: string) => Money.fromString(value, entity.currency);
    return LedgerEntry.rehydrate({
      id: entity.id, walletId: entity.walletId, transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection, // garantido pelo CHECK do schema
      money: money(entity.amount), balanceBefore: money(entity.balanceBefore), balanceAfter: money(entity.balanceAfter),
      createdAt: entity.createdAt,
    });
  },

  toEntity(entry: LedgerEntry): LedgerEntryEntity {
    const entity = new LedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toString();
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.toString();
    entity.balanceAfter = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    return entity;
  },
};
