import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Tabela `outbox_messages`: `id` = `eventId`; `payload` é o envelope serializado (jsonb, dinheiro como string). */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'string', fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'next_attempt_at' })
  nextAttemptAt!: Date;

  @Property({ type: 'Date', columnType: 'timestamptz', fieldName: 'published_at', nullable: true })
  publishedAt!: Date | null;
}
