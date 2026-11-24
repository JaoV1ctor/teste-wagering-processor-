/** Contexto de um evento: o que o envelope precisa e o evento não descobre sozinho (ids e relógio entram de fora; o domínio é determinístico). */
export interface EventContext {
  eventId: string;
  correlationId: string;
  /** O que causou este evento (por exemplo, o evento anterior do mesmo processamento). Ausente quando não há causa a apontar. */
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  /** Raiz do agregado que o evento descreve (transação ou wallet); é por ele que um consumidor agrupa e ordena. */
  aggregateId: string;
  data: T;
}

/** Envelope serializado: é exatamente o que vai no `payload` do outbox e no corpo da mensagem publicada (README §11). */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope de todo evento de integração. Cada evento é UMA subclasse: `eventType` e `version` pertencem ao tipo, não a uma string solta
 * no ponto de uso. `data` só carrega tipos JSON (dinheiro como `MoneyProps`, com strings decimais): o payload precisa ser estável e versionável.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
