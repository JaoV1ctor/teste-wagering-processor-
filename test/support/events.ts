// Apoio dos testes do outbox: lê o que foi GRAVADO (Postgres) e o que foi PUBLICADO (fila real), e confere a invariante entre eventos e ledger.
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type pg from 'pg';
import { expect } from 'bun:test';
import { ledgerBalance } from './db';
import { waitFor } from './sqs';

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: EventEnvelope;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

/** Envelope como gravado no outbox e publicado na fila. `data` é livre por tipo de evento. */
export interface EventEnvelope {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, any>;
}

const COLUMNS = 'id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at';

/** Eventos de uma transação, em ordem estável de tipo (Processed, depois BalanceChanged). */
export async function outboxOfTransaction(probe: pg.Pool, transactionId: string): Promise<OutboxRow[]> {
  const { rows } = await probe.query<OutboxRow>(`select ${COLUMNS} from outbox_messages where payload->'data'->>'transactionId' = $1 order by event_type`, [transactionId]);
  return rows;
}

/**
 * Eventos de uma wallet, em ordem de ocorrência. Por padrão SEM os da abertura (OPENING): quase todo teste cria a wallet com saldo e
 * quer ver só o que a aposta gerou. `includeOpening` os inclui (testes da abertura e da invariante contra o ledger).
 */
export async function outboxOfWallet(probe: pg.Pool, walletId: string, { includeOpening = false } = {}): Promise<OutboxRow[]> {
  const notOpening = "and payload->'data'->>'transactionId' not in (select id::text from wager_transactions where wallet_id = $1::uuid and kind = 'OPENING')";
  const { rows } = await probe.query<OutboxRow>(
    `select ${COLUMNS} from outbox_messages where payload->'data'->>'walletId' = $1::text ${includeOpening ? '' : notOpening} order by occurred_at, event_type, id`,
    [walletId],
  );
  return rows;
}

export const typesOf = (rows: OutboxRow[]): string[] => rows.map((row) => row.event_type);

/**
 * Invariante final estendida aos eventos: saldo == ledger; todo `WalletBalanceChanged` tem o lançamento correspondente
 * (mesma transação, direção, valor, antes e depois) e todo lançamento, inclusive o de abertura (OPENING), tem o seu evento.
 */
export async function expectEventsConsistentWithLedger(probe: pg.Pool, walletId: string): Promise<void> {
  const balance = await ledgerBalance(probe, walletId);
  expect(balance.stored).toBe(balance.rebuilt);

  const { rows: entries } = await probe.query<{ transaction_id: string; direction: string; amount: string; balance_before: string; balance_after: string }>(
    `select l.transaction_id, l.direction, l.amount::text, l.balance_before::text, l.balance_after::text
       from wallet_ledger_entries l
      where l.wallet_id = $1 order by l.seq`, [walletId]);
  const changes = (await outboxOfWallet(probe, walletId, { includeOpening: true })).filter((row) => row.event_type === 'WalletBalanceChanged');

  expect(changes).toHaveLength(entries.length);
  for (const change of changes) {
    const entry = entries.find((e) => e.transaction_id === change.payload.data['transactionId']);
    expect(entry).toBeDefined();
    expect(change.payload.data).toMatchObject({
      direction: entry?.direction, money: { amount: entry?.amount }, balanceBefore: { amount: entry?.balance_before }, balanceAfter: { amount: entry?.balance_after },
    });
  }
  const { rows: wallet } = await probe.query<{ version: number }>('select version from wallets where id = $1', [walletId]);
  const lastVersion = Math.max(1, ...changes.map((change) => change.payload.data['walletVersion'] as number));
  expect(lastVersion).toBe(wallet[0]?.version ?? -1);
}

export interface ReceivedEvent {
  envelope: EventEnvelope;
  attributes: Record<string, string>;
}

/**
 * Consumidor de teste da fila padrão `wager-events`: lê e apaga tudo o que está visível e acumula. Deduplica por `eventId`, como o consumidor
 * real deve fazer (entrega at-least-once), e CONTA as repetições.
 */
export class EventSink {
  readonly received: ReceivedEvent[] = [];

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async collect(): Promise<void> {
    for (;;) {
      const { Messages = [] } = await this.client.send(
        new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 30, MessageAttributeNames: ['All'] }),
      );
      if (Messages.length === 0) return;
      for (const message of Messages) {
        this.received.push({
          envelope: JSON.parse(message.Body ?? 'null') as EventEnvelope,
          attributes: Object.fromEntries(Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [name, value.StringValue ?? ''])),
        });
        await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
    }
  }

  /** Espera (consultando, nunca dormindo às cegas) até `condition` valer sobre o que já chegou. */
  async waitUntil(description: string, condition: (sink: EventSink) => boolean, timeoutMs = 20_000): Promise<void> {
    await waitFor(description, async () => {
      await this.collect();
      return condition(this);
    }, timeoutMs);
  }

  get ids(): string[] {
    return this.received.map((r) => r.envelope.eventId);
  }

  get uniqueIds(): Set<string> {
    return new Set(this.ids);
  }

  /** Mensagens além da primeira cópia de cada `eventId`: publicação duplicada, segura porque o `eventId` é estável. */
  get duplicates(): number {
    return this.ids.length - this.uniqueIds.size;
  }
}
