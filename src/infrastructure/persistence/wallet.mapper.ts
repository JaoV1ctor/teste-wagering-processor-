import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletEntity } from './wallet.entity';

export const WalletMapper = {
  toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id, playerId: entity.playerId, currency: entity.currency,
      balance: Money.fromString(entity.balance, entity.currency), version: entity.version,
      createdAt: entity.createdAt, updatedAt: entity.updatedAt,
    });
  },

  toEntity(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balance = wallet.balance.toString();
    entity.version = wallet.version;
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    return entity;
  },
};
