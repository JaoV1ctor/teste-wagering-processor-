/** Os quatro cenários. Cada um: ambiente isolado, aquecimento descartado, N repetições medidas e as invariantes no final. */
import { randomUUID } from 'node:crypto';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { buildWagerMessage } from '../send-wager-message';
import { idempotencyKeyOf, openWallet, submit, type SubmitOutcome, type WagerPayload, type Wallet } from './client';
import type { LoadConfig, ScenarioId } from './config';
import { type Check, checkInvariants, type InvariantReport } from './invariants';
import { count, type Counters, difference, drainOutbox, outboxLag, readCounters, waitUntil } from './measure';
import { INDEPENDENT, MIXED, type Mix, pickKind, type PlannedKind, randomFrom, scheduleReplays } from './plan';
import { runPool } from './pool';
import { createDatabase, createLoadQueues, deleteQueues, type Instances, type LoadDatabase, type LoadQueues, startInstances } from './stack';
import { type Distribution, distribution } from './stats';

export interface Repetition {
  sent: number;
  durationSeconds: number;
  /** Requisições (ou mensagens) por segundo. */
  throughput: number;
  /** Só nos cenários HTTP. */
  latency?: Distribution | undefined;
  statuses: Record<string, number>;
  kinds: Record<string, number>;
  counters: Counters;
  outboxLag: Distribution | undefined;
  outboxDrainSeconds: number;
  /** Cenário D. */
  replays?: { sent: number; answeredAsReplay: number; original: Distribution | undefined; replay: Distribution | undefined };
  /** Cenário C. */
  queue?: { enqueueSeconds: number; spawnToDoneSeconds: number; processingWindowSeconds: number };
}

export interface ScenarioResult {
  id: ScenarioId;
  title: string;
  repetitions: Repetition[];
  invariants: InvariantReport;
}

export interface Context {
  config: LoadConfig;
  client: SQSClient;
  /** Identifica a execução em nomes de banco, filas e ids. */
  runId: string;
  errorLog: string;
  progress(message: string): void;
}

const INITIAL_BALANCE = '1000000.00';
const AMOUNT: Record<PlannedKind, string> = { BET: '10.00', WIN: '15.00', LOSS: '10.00', REFUND: '10.00' };

interface Isolated {
  database: LoadDatabase;
  queues: LoadQueues;
  /** Filas extras criadas durante o cenário, para apagar no fim. */
  extra: LoadQueues[];
  start(input?: LoadQueues, count?: number): Promise<Instances>;
}

async function isolated<T>({ client, runId, config, errorLog }: Context, id: ScenarioId, work: (stack: Isolated) => Promise<T>): Promise<T> {
  const database = await createDatabase(`${runId}_${id}`);
  const extra: LoadQueues[] = [];
  let queues: LoadQueues | undefined;
  try {
    queues = await createLoadQueues(client, `load-${runId}-${id}-`);
    const main = queues;
    return await work({
      database, queues: main, extra,
      start: (input = main, instances = config.instances) =>
        startInstances({ count: instances, databaseUrl: database.url, input: input.input, deadLetter: input.deadLetter, events: main.events, errorLog }),
    });
  } finally {
    await deleteQueues(client, [...(queues ? [queues] : []), ...extra]);
    await database.drop();
  }
}

const tally = (values: readonly string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((totals, value) => ({ ...totals, [value]: (totals[value] ?? 0) + 1 }), {});

const openWallets = (url: string, howMany: number): Promise<Wallet[]> =>
  runPool(8, Array.from({ length: howMany }, () => () => openWallet(url, INITIAL_BALANCE)));

function wagerPayload(wallet: Wallet, kind: PlannedKind, externalTransactionId: string): WagerPayload {
  return {
    providerId: 'load', externalTransactionId, ...wallet, roundId: 'round-1', gameId: 'game-1', kind, money: { amount: AMOUNT[kind], currency: 'BRL' },
  };
}

interface Batch {
  sends: (() => Promise<{ payload: WagerPayload; outcome: SubmitOutcome }>)[];
}

/** Cenários A e B: cada envio é uma operação nova; o REFUND reverte uma BET já confirmada nesta repetição. */
function mixedBatch(urls: string[], wallets: Wallet[], total: number, label: string, random: () => number, mix: Mix): Batch {
  const refundable: WagerPayload[] = [];
  return {
    sends: Array.from({ length: total }, (_, index) => {
      const planned = pickKind(mix, random);
      const wallet = wallets[Math.floor(random() * wallets.length)]!;
      return async () => {
        const id = `${label}-${index}`;
        const bet = planned === 'REFUND' ? refundable.shift() : undefined;
        const payload: WagerPayload = bet
          ? { ...bet, externalTransactionId: id, kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }
          : wagerPayload(wallet, planned === 'REFUND' ? 'BET' : planned, id);
        const outcome = await submit(urls[index % urls.length]!, payload);
        if (payload.kind === 'BET' && outcome.status === 201) refundable.push(payload);
        return { payload, outcome };
      };
    }),
  };
}

/** Cenário D: parte dos envios repete uma operação (mesma Idempotency-Key e mesmo corpo), inclusive para outra instância. */
function replayBatch(urls: string[], wallets: Wallet[], config: LoadConfig, total: number, label: string, random: () => number): Batch {
  const order = scheduleReplays(total, config.replayPercent, config.concurrency * 2, random);
  const operations = Array.from({ length: Math.max(...order) + 1 }, (_, index) =>
    wagerPayload(wallets[Math.floor(random() * wallets.length)]!, pickKind(INDEPENDENT, random), `${label}-${index}`));
  return {
    sends: order.map((operation, index) => async () => {
      const payload = operations[operation]!;
      return { payload, outcome: await submit(urls[index % urls.length]!, payload) };
    }),
  };
}

/** Respostas incoerentes para uma mesma chave: mais de um "original" ou transações diferentes. */
function replayAnomalies(results: readonly { payload: WagerPayload; outcome: SubmitOutcome }[]): number {
  const byKey = new Map<string, SubmitOutcome[]>();
  for (const { payload, outcome } of results) {
    const key = idempotencyKeyOf(payload);
    byKey.set(key, [...(byKey.get(key) ?? []), outcome]);
  }
  let anomalies = 0;
  for (const outcomes of byKey.values()) {
    const accepted = outcomes.filter((outcome) => outcome.status === 201);
    if (accepted.length === 0) continue;
    const originals = accepted.filter((outcome) => outcome.idempotentReplay === false).length;
    // Zero originais só é possível se a resposta do original se perdeu (503, timeout ou rede).
    const lostOriginal = accepted.length < outcomes.length;
    if (originals > 1 || (originals === 0 && !lostOriginal)) anomalies += 1;
    if (new Set(accepted.map((outcome) => outcome.transactionId)).size !== 1) anomalies += 1;
  }
  return anomalies;
}

async function httpScenario(context: Context, id: 'A' | 'B' | 'D', title: string): Promise<ScenarioResult> {
  const { config, progress } = context;
  return isolated(context, id, async (stack) => {
    const instances = await stack.start();
    try {
      const random = randomFrom(config.seed);
      const accepted = new Set<string>();
      let anomalies = 0;
      const walletsFor = () => openWallets(instances.urls[0]!, id === 'B' ? 1 : config.wallets);
      const wallets = id === 'B' ? undefined : await walletsFor();

      const run = async (total: number, label: string): Promise<Repetition> => {
        const targets = wallets ?? (await walletsFor()); // B: uma wallet quente nova por repetição
        const batch = id === 'D'
          ? replayBatch(instances.urls, targets, config, total, label, random)
          : mixedBatch(instances.urls, targets, total, label, random, MIXED);
        await drainOutbox(stack.database.pool);
        const before = await readCounters(instances.urls, stack.database.pool);
        const from = new Date();
        const started = Bun.nanoseconds();
        const results = await runPool(config.concurrency, batch.sends);
        const durationSeconds = (Bun.nanoseconds() - started) / 1e9;
        const to = new Date();
        const outboxDrainSeconds = await drainOutbox(stack.database.pool);
        const counters = difference(await readCounters(instances.urls, stack.database.pool), before);

        for (const { payload, outcome } of results) if (outcome.status === 201 || outcome.status === 422) accepted.add(idempotencyKeyOf(payload));
        anomalies += replayAnomalies(results);
        const latencies = (keep: (outcome: SubmitOutcome) => boolean) => distribution(results.map((r) => r.outcome).filter(keep).map((o) => o.latencyMs));
        const unique = new Set(results.map((r) => idempotencyKeyOf(r.payload))).size;
        return {
          sent: results.length,
          durationSeconds,
          throughput: results.length / durationSeconds,
          latency: latencies(() => true),
          statuses: tally(results.map((r) => String(r.outcome.status))),
          kinds: tally(results.map((r) => r.payload.kind)),
          counters,
          outboxLag: await outboxLag(stack.database.pool, from, to),
          outboxDrainSeconds,
          ...(id === 'D' ? {
            replays: {
              sent: results.length - unique,
              answeredAsReplay: results.filter((r) => r.outcome.idempotentReplay === true).length,
              original: latencies((outcome) => outcome.idempotentReplay === false),
              replay: latencies((outcome) => outcome.idempotentReplay === true),
            },
          } : {}),
        };
      };

      if (config.warmupRequests > 0) {
        progress(`${id}: aquecimento (${config.warmupRequests} requisições, descartadas)`);
        await run(config.warmupRequests, `${context.runId}-${id}-warmup`);
      }
      const repetitions: Repetition[] = [];
      for (let rep = 1; rep <= config.repetitions; rep += 1) {
        const result = await run(config.requests, `${context.runId}-${id}-${rep}`);
        progress(`${id}: repetição ${rep}/${config.repetitions}: ${result.throughput.toFixed(1)} req/s, p99 ${result.latency?.p99.toFixed(1)} ms`);
        repetitions.push(result);
      }

      progress(`${id}: conferindo invariantes`);
      const extra: Check[] = id === 'D' ? [{ name: 'chaves com respostas incoerentes (mais de um original ou transações diferentes)', observed: anomalies, expected: 0 }] : [];
      const invariants = await checkInvariants({
        pool: stack.database.pool, apiUrl: instances.urls[0]!, client: context.client, eventsQueueUrl: stack.queues.events.url, acceptedKeys: accepted, extra,
      });
      return { id, title, repetitions, invariants };
    } finally {
      await instances.stop();
    }
  });
}

/** Envia em lotes de 10, o máximo do `SendMessageBatch`. `MessageGroupId` = walletId em minúsculas. */
async function enqueue(client: SQSClient, queueUrl: string, payloads: readonly WagerPayload[]): Promise<void> {
  const batches = Array.from({ length: Math.ceil(payloads.length / 10) }, (_, index) => payloads.slice(index * 10, index * 10 + 10));
  await runPool(8, batches.map((batch) => async () => {
    const response = await client.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: batch.map((payload, index) => {
        const { money, ...fields } = payload;
        const message = buildWagerMessage({ ...fields, amount: money.amount, currency: money.currency, messageId: randomUUID() });
        return {
          Id: String(index), MessageBody: JSON.stringify(message), MessageGroupId: message.data.walletId.toLowerCase(), MessageDeduplicationId: message.messageId,
        };
      }),
    }));
    if ((response.Failed ?? []).length > 0) throw new Error(`SendMessageBatch recusou ${response.Failed?.length} mensagem(ns)`);
  }));
}

/**
 * Cenário C: a fila é enchida SEM consumidor; então as instâncias sobem e a drenagem é medida. Cada repetição usa filas de entrada novas
 * (um long polling de instância já encerrada não pode reter mensagens) e, portanto, processos recém-iniciados.
 */
async function queueScenario(context: Context, title: string): Promise<ScenarioResult> {
  const { config, client, progress } = context;
  return isolated(context, 'C', async (stack) => {
    const random = randomFrom(config.seed);
    const accepted = new Set<string>();
    const { pool } = stack.database;

    // Instância só de preparação: cria as wallets e é encerrada antes de qualquer medição (o publisher dela não ajuda na drenagem).
    const setup = await stack.start(stack.queues, 1);
    let wallets: Wallet[];
    try {
      wallets = await openWallets(setup.urls[0]!, config.wallets);
      await drainOutbox(pool);
    } finally {
      await setup.stop();
    }

    const run = async (total: number, label: string): Promise<Repetition> => {
      const queues = await createLoadQueues(client, `load-${context.runId}-C-${label}-`);
      stack.extra.push({ ...queues });
      const payloads = Array.from({ length: total }, (_, index) =>
        wagerPayload(wallets[Math.floor(random() * wallets.length)]!, pickKind(INDEPENDENT, random), `${context.runId}-C-${label}-${index}`));
      const enqueueStarted = Bun.nanoseconds();
      await enqueue(client, queues.input.url, payloads);
      const enqueueSeconds = (Bun.nanoseconds() - enqueueStarted) / 1e9;

      const ids = payloads.map((payload) => payload.externalTransactionId);
      const processed = () => count(pool, 'select 1 from wager_transactions where external_transaction_id = any($1)', [ids]);
      const deadlocksBefore = (await readCounters([], pool)).deadlocks;
      const from = new Date();
      const spawned = Bun.nanoseconds();
      const instances = await stack.start(queues);
      try {
        await waitUntil(`${total} mensagens processadas`, async () => (await processed()) === total, 600_000);
        // Inclui a subida dos processos: o consumo começa assim que cada um sobe, antes de todos passarem no readiness.
        const spawnToDoneSeconds = (Bun.nanoseconds() - spawned) / 1e9;
        const to = new Date();
        const outboxDrainSeconds = await drainOutbox(pool);
        const counters = await readCounters(instances.urls, pool); // instâncias novas: os contadores partem de zero
        const { rows } = await pool.query<{ window: string }>(
          'select extract(epoch from (max(processed_at) - min(processed_at)))::text as window from wager_transactions where external_transaction_id = any($1)', [ids]);
        const processingWindowSeconds = parseFloat(rows[0]!.window);
        for (const payload of payloads) accepted.add(idempotencyKeyOf(payload));
        const { rows: statuses } = await pool.query<{ status: string }>('select status from wager_transactions where external_transaction_id = any($1)', [ids]);
        return {
          sent: total,
          durationSeconds: processingWindowSeconds,
          // n mensagens delimitam n - 1 intervalos entre o primeiro e o último processamento.
          throughput: processingWindowSeconds > 0 ? (total - 1) / processingWindowSeconds : 0,
          statuses: tally(statuses.map((row) => row.status)),
          kinds: tally(payloads.map((payload) => payload.kind)),
          counters: { ...counters, deadlocks: counters.deadlocks - deadlocksBefore },
          outboxLag: await outboxLag(pool, from, to),
          outboxDrainSeconds,
          queue: { enqueueSeconds, spawnToDoneSeconds, processingWindowSeconds },
        };
      } finally {
        await instances.stop();
      }
    };

    if (config.warmupRequests > 0) {
      progress(`C: aquecimento (${config.warmupRequests} mensagens, descartadas)`);
      await run(config.warmupRequests, 'warmup');
    }
    const repetitions: Repetition[] = [];
    for (let rep = 1; rep <= config.repetitions; rep += 1) {
      const result = await run(config.requests, String(rep));
      progress(`C: repetição ${rep}/${config.repetitions}: ${result.throughput.toFixed(1)} msg/s`);
      repetitions.push(result);
    }

    progress('C: conferindo invariantes');
    const check = await stack.start(stack.queues, 1);
    try {
      const messages = await count(pool, 'select 1 from inbox_messages');
      const invariants = await checkInvariants({
        pool, apiUrl: check.urls[0]!, client, eventsQueueUrl: stack.queues.events.url, acceptedKeys: accepted,
        extra: [{ name: 'mensagens registradas no inbox (uma por enviada)', observed: messages, expected: accepted.size }],
      });
      return { id: 'C' as const, title, repetitions, invariants };
    } finally {
      await check.stop();
    }
  });
}

export const SCENARIOS: Record<ScenarioId, (context: Context) => Promise<ScenarioResult>> = {
  A: (context) => httpScenario(context, 'A', 'Distribuído: muitas wallets, BET/WIN/LOSS/REFUND por HTTP'),
  B: (context) => httpScenario(context, 'B', 'Hot wallet: todas as requisições na mesma wallet'),
  C: (context) => queueScenario(context, 'Mensageria: drenagem de um lote de mensagens SQS'),
  D: (context) => httpScenario(context, 'D', 'Duplicatas: reenvios com a mesma Idempotency-Key'),
};
