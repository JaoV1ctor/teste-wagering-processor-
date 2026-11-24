import { Wallet } from '../../domain/wallet';
import { WalletEntity } from './wallet.entity';

/** "1000.00" -> 100000n. Exige exatamente 2 casas: o que o banco devolve em NUMERIC(19,2). */
export function decimalToCents(value: string): bigint {
  if (!/^\d+\.\d{2}$/.test(value)) throw new Error(`Decimal inválido vindo do banco: ${value}`);
  return BigInt(value.replace('.', ''));
}

export function centsToDecimal(cents: bigint): string {
  if (cents < 0n) throw new Error('Saldo negativo não é representável');
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const WalletMapper = {
  toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id, playerId: entity.playerId, currency: entity.currency,
      balanceCents: decimalToCents(entity.balance), version: entity.version,
      createdAt: entity.createdAt, updatedAt: entity.updatedAt,
    });
  },

  toEntity(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balance = centsToDecimal(wallet.balanceCents);
    entity.version = wallet.version;
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    return entity;
  },
};
