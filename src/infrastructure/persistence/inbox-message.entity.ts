import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Tabela `inbox_messages`: PK `(consumer_name, message_id)` é a deduplicação persistente. */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', fieldName: 'message_id' })
  messageId!: string;

  @Property({ type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
