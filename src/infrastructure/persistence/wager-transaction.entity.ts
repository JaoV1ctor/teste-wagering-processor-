import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Tabela `wager_transactions`. Opcionais são `null` no banco (o mapper converte de/para `undefined`). */
@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', fieldName: 'provider_id' })
  providerId!: string;

  @Property({ type: 'string', fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ type: 'string', fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', fieldName: 'round_id' })
  roundId!: string;

  @Property({ type: 'string', fieldName: 'game_id' })
  gameId!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  @Property({ type: 'string', fieldName: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId!: string | null;

  @Property({ type: 'uuid', fieldName: 'reference_transaction_id', nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: 'string' })
  status!: string;

  @Property({ type: 'string', fieldName: 'failure_code', nullable: true })
  failureCode!: string | null;

  @Property({ type: 'string', columnType: 'numeric(19,2)', fieldName: 'observed_balance', nullable: true })
  observedBalance!: string | null;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'updated_at' })
  updatedAt!: Date;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
