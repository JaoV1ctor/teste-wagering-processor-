/** As condições sem as quais os números de um cenário não valem. Conferidas ao fim de cada cenário, sobre TODAS as wallets do banco dele. */
import { DeleteMessageBatchCommand, GetQueueAttributesCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type pg from 'pg';
import { reconcile } from './client';
import { count, waitUntil } from './measure';
import { runPool } from './pool';

export interface Check {
  name: string;
  observed: number;
  expected: number;
}

export interface EventStats {
  inOutbox: number;
  received: number;
  unique: number;
  /** Entregas a mais do mesmo `eventId`: permitidas (at-least-once). */
  rawDuplicates: number;
}

export interface InvariantReport {
  ok: boolean;
  checks: Check[];
  events: EventStats;
}

interface Envelope {
  eventId: string;
  eventType: string;
  data: { transactionId?: string; walletId?: string; walletVersion?: number };
}

/** Consome a fila de eventos até receber todos os `expected` e ela ficar vazia. Deduplica por `eventId`, como um consumidor real. */
async function consumeEvents(client: SQSClient, queueUrl: string, expected: ReadonlySet<string>): Promise<{ received: number; unique: Map<string, Envelope> }> {
  const unique = new Map<string, Envelope>();
  let received = 0;
  const receive = async (): Promise<number> => {
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 60 }));
    const messages = response.Messages ?? [];
    for (const message of messages) {
      const envelope = JSON.parse(message.Body ?? '{}') as Envelope;
      received += 1;
      if (!unique.has(envelope.eventId)) unique.set(envelope.eventId, envelope);
    }
    if (messages.length > 0) {
      await client.send(new DeleteMessageBatchCommand({
        QueueUrl: queueUrl, Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle! })),
      }));
    }
    return messages.length;
  };
  const empty = async (): Promise<boolean> => {
    const { Attributes } = await client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    return Attributes?.['ApproximateNumberOfMessages'] === '0' && Attributes?.['ApproximateNumberOfMessagesNotVisible'] === '0';
  };
  await waitUntil('fila de eventos consumida', async () => {
    const batches = await Promise.all(Array.from({ length: 8 }, receive));
    return batches.every((size) => size === 0) && [...expected].every((id) => unique.has(id)) && (await empty());
  }, 180_000);
  return { received, unique };
}

/** Eventos DIFERENTES (outro `eventId`) para o mesmo fato: o que a deduplicação por `eventId` não pegaria. */
function repeatedFacts(events: Iterable<Envelope>): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const { eventType, data } of events) {
    const facts = [`${eventType}:${data.transactionId}`];
    if (eventType === 'WalletBalanceChanged') facts.push(`version:${data.walletId}:${data.walletVersion}`);
    for (const fact of facts) {
      if (seen.has(fact)) repeated += 1;
      seen.add(fact);
    }
  }
  return repeated;
}

export interface InvariantInput {
  pool: pg.Pool;
  apiUrl: string;
  client: SQSClient;
  eventsQueueUrl: string;
  /** Chaves de idempotência que a carga viu aceitas (cada uma precisa existir exatamente uma vez). */
  acceptedKeys: ReadonlySet<string>;
  /** Verificações próprias do cenário. */
  extra?: Check[];
}

export async function checkInvariants({ pool, apiUrl, client, eventsQueueUrl, acceptedKeys, extra = [] }: InvariantInput): Promise<InvariantReport> {
  const { rows: wallets } = await pool.query<{ id: string }>('select id from wallets');
  const reconciliations = await runPool(8, wallets.map((wallet) => () => reconcile(apiUrl, wallet.id)));

  const { rows: outbox } = await pool.query<{ id: string }>('select id from outbox_messages');
  const outboxIds = new Set(outbox.map((row) => row.id));
  const consumed = await consumeEvents(client, eventsQueueUrl, outboxIds);

  const zero = async (name: string, sql: string, params: unknown[] = []): Promise<Check> => ({ name, observed: await count(pool, sql, params), expected: 0 });

  const checks: Check[] = [
    { name: 'wallets reconciliadas pela API', observed: reconciliations.length, expected: wallets.length },
    { name: 'wallets com saldo diferente do ledger (API)', observed: reconciliations.filter((r) => !r.consistent).length, expected: 0 },
    await zero('wallets com saldo diferente da soma do ledger (SQL)',
      `select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id group by w.id
       having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`),
    await zero('saldos negativos (wallet ou lançamento)',
      'select 1 from wallets where balance < 0 union all select 1 from wallet_ledger_entries where balance_after < 0 or balance_before < 0'),
    await zero('chaves de idempotência com mais de uma transação', 'select idempotency_key from wager_transactions group by 1 having count(*) > 1'),
    await zero('identidades (provedor, id externo) repetidas',
      'select provider_id, external_transaction_id from wager_transactions group by 1, 2 having count(*) > 1'),
    await zero('transações com mais de um lançamento', 'select transaction_id from wallet_ledger_entries group by 1 having count(*) > 1'),
    await zero('movimentos PROCESSED sem lançamento',
      `select t.id from wager_transactions t left join wallet_ledger_entries l on l.transaction_id = t.id
        where t.status = 'PROCESSED' and t.kind <> 'LOSS' and l.id is null`),
    await zero('lançamentos de transação não processada ou de LOSS',
      `select l.id from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.status <> 'PROCESSED' or t.kind = 'LOSS'`),
    {
      name: 'chaves aceitas que não estão gravadas',
      observed: acceptedKeys.size - (await count(pool, 'select 1 from wager_transactions where idempotency_key = any($1)', [[...acceptedKeys]])),
      expected: 0,
    },
    { name: 'eventos do outbox que não chegaram à fila', observed: [...outboxIds].filter((id) => !consumed.unique.has(id)).length, expected: 0 },
    { name: 'eventos recebidos que não estão no outbox', observed: [...consumed.unique.keys()].filter((id) => !outboxIds.has(id)).length, expected: 0 },
    { name: 'fatos repetidos depois de deduplicar por eventId', observed: repeatedFacts(consumed.unique.values()), expected: 0 },
    ...extra,
  ];
  return {
    ok: checks.every((check) => check.observed === check.expected),
    checks,
    events: { inOutbox: outboxIds.size, received: consumed.received, unique: consumed.unique.size, rawDuplicates: consumed.received - consumed.unique.size },
  };
}
