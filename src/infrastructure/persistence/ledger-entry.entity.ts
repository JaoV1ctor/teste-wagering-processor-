import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Tabela `wallet_ledger_entries` (somente inserção; imutável por trigger). */
@Entity({ tableName: 'wallet_ledger_entries' })
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  /** Atribuído pelo trigger `ledger_chain_check` ao inserir: a aplicação nunca informa. `nullable` só evita a validação de obrigatório do ORM. */
  @Property({ type: 'bigint', nullable: true })
  seq?: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'string' })
  direction!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)', fieldName: 'balance_before' })
  balanceBefore!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)', fieldName: 'balance_after' })
  balanceAfter!: string;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;
}
