import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Entidade de PERSISTÊNCIA (tabela `wallets`). Não é o domínio: o mapper converte entre os dois. */
@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  /** NUMERIC(19,2) chega como string decimal do driver: nunca vira number. */
  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'updated_at' })
  updatedAt!: Date;
}
