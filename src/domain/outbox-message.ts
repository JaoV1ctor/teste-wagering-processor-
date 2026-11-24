import { InvalidOutboxMessageError } from './errors';
import type { IntegrationEvent } from './events/integration-event';
import { outboxRetryDelayMs } from './outbox-retry-policy';

export interface OutboxMessageState {
  /** = `eventId` do evento: o consumidor deduplica por ele. */
  id: string;
  aggregateId: string;
  eventType: string;
  /** Envelope serializado (`IntegrationEvent.toJSON()`), com dinheiro como string. */
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  /** Publicações que falharam. A reivindicação por lease não conta como tentativa. */
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
}

/**
 * Evento a publicar (README §6.5). Nasce na MESMA transação SQL do fato que descreve e só sai do estado "pendente" quando alguém
 * confirma a publicação (`markPublished`). Quem publica reivindica por lease; a exclusão mútua é do banco, não desta classe.
 */
export class OutboxMessage {
  private constructor(private state: OutboxMessageState) {}

  /** Vence imediatamente (`nextAttemptAt = occurredAt`). */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
    });
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): Readonly<Record<string, unknown>> { return this.state.payload; }
  get occurredAt(): Date { return this.state.occurredAt; }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date { return this.state.nextAttemptAt; }
  get publishedAt(): Date | undefined { return this.state.publishedAt; }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this.state = { ...this.state, publishedAt: at };
  }

  /** A publicação falhou: soma a tentativa e agenda a próxima com backoff exponencial e jitter a partir de `now`. */
  scheduleRetry(now: Date, random: () => number = Math.random): void {
    this.assertPending('scheduleRetry');
    const attempts = this.state.attempts + 1;
    this.state = { ...this.state, attempts, nextAttemptAt: new Date(now.getTime() + outboxRetryDelayMs(attempts, random)) };
  }

  toState(): OutboxMessageState {
    return { ...this.state };
  }

  private assertPending(attempted: string): void {
    if (!this.isPending()) throw new InvalidOutboxMessageError(`Evento ${this.state.id} já foi publicado e não aceita ${attempted}`);
  }
}
