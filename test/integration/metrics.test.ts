// GET /metrics. Aplicação real sobre Postgres REAL: o formato Prometheus e os VALORES depois de operações reais
// (aposta processada, duplicata, rejeição, pendência). Cada `startApi()` tem o seu registry, então os valores são absolutos.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, startApi } from '../support/app';
import { createProbe, divergentWallets, ensureSchema, parkOutbox } from '../support/db';
import { type MetricsPage, scrape, total } from '../support/metrics';
import { defaultKey, openWallet, reversalPayload, submit, wagerPayload } from '../support/wager';

const probe = createProbe();
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterAll(async () => {
  const divergent = await divergentWallets(probe);
  await api.close();
  await probe.end();
  expect(divergent).toEqual([]); // invariante final: wallet.balance == saldo reconstruído pelo ledger
});

const money = (amount: string) => ({ amount, currency: 'BRL' });

const EXPECTED_TYPES: Record<string, string> = {
  wager_transactions_total: 'counter',
  wager_duplicates_total: 'counter',
  wager_retries_total: 'counter',
  wager_dlq_messages_total: 'counter',
  wager_lock_conflicts_total: 'counter',
  wager_wallet_lock_wait_seconds: 'histogram',
  wager_outbox_lag_seconds: 'gauge',
  wager_processing_duration_seconds: 'histogram',
  wager_reconciliation_divergence_total: 'counter',
};

describe('formato (exposição Prometheus)', () => {
  test('200, content-type do formato texto e HELP/TYPE de cada métrica do serviço com o tipo certo', async () => {
    const res = await fetch(`${api.url}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toStartWith('text/plain; version=0.0.4');
    const text = await res.text();
    for (const [name, type] of Object.entries(EXPECTED_TYPES)) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} ${type}`);
    }
  });

  test('toda linha é comentário ou amostra válida (nome, labels entre aspas, valor numérico)', async () => {
    const page = await scrape(api);
    expect(page.samples.length).toBeGreaterThan(0);
    for (const sample of page.samples) expect(Number.isNaN(sample.value)).toBe(false);
  });

  test('sem autenticação e sem métricas do processo que não são nossas (só as do serviço)', async () => {
    const page = await scrape(api);
    const names = new Set(page.samples.map((s) => s.name.replace(/_(bucket|sum|count)$/, '')));
    for (const name of names) expect(Object.keys(EXPECTED_TYPES)).toContain(name);
  });
});

describe('valores depois de operações reais', () => {
  let page: MetricsPage;

  beforeAll(async () => {
    const wallet = await openWallet(api, '100.00');

    const bet = wagerPayload(wallet, { money: money('30.00') });
    expect((await submit(api, bet, defaultKey(bet))).status).toBe(201); // BET processada
    expect((await submit(api, bet, defaultKey(bet))).body.idempotentReplay).toBe(true); // duplicata (replay)
    const loss = wagerPayload(wallet, { kind: 'LOSS', money: money('10.00') });
    expect((await submit(api, loss, defaultKey(loss))).status).toBe(201); // LOSS processada
    const tooBig = wagerPayload(wallet, { money: money('500.00') });
    expect((await submit(api, tooBig, defaultKey(tooBig))).status).toBe(422); // rejeitada: saldo insuficiente
    const refund = reversalPayload(wallet, wagerPayload(wallet), 'REFUND');
    expect((await submit(api, refund, defaultKey(refund))).status).toBe(202); // referência ausente: PENDING_REFERENCE
    const conflicting = { ...bet, money: money('31.00') };
    expect((await submit(api, conflicting, defaultKey(bet))).status).toBe(409); // conflito: não é transação nova

    page = await scrape(api);
  });

  test('wager_transactions_total{status,kind}: uma amostra por resultado decidido; replay e conflito não contam', () => {
    expect(total(page, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
    expect(total(page, 'wager_transactions_total', { status: 'PROCESSED', kind: 'LOSS' })).toBe(1);
    expect(total(page, 'wager_transactions_total', { status: 'REJECTED', kind: 'BET' })).toBe(1);
    expect(total(page, 'wager_transactions_total', { status: 'PENDING_REFERENCE', kind: 'REFUND' })).toBe(1);
    expect(total(page, 'wager_transactions_total')).toBe(4);
  });

  test('wager_duplicates_total: o replay conta uma vez', () => {
    expect(total(page, 'wager_duplicates_total')).toBe(1);
  });

  test('wager_processing_duration_seconds: uma observação por execução que terminou com resultado (4 novas + 1 replay)', () => {
    const count = total(page, 'wager_processing_duration_seconds_count');
    expect(count).toBe(5);
    expect(total(page, 'wager_processing_duration_seconds_sum')).toBeGreaterThan(0);
    expect(total(page, 'wager_processing_duration_seconds_bucket', { le: '+Inf' })).toBe(count);
    const buckets = page.samples.filter((s) => s.name === 'wager_processing_duration_seconds_bucket').map((s) => s.value);
    expect([...buckets].sort((a, b) => a - b)).toEqual(buckets); // cumulativo: nunca decresce com o `le`
  });

  test('wager_wallet_lock_wait_seconds: uma observação por lock de wallet (as 4 execuções novas; o replay não trava)', () => {
    expect(total(page, 'wager_wallet_lock_wait_seconds_count')).toBe(4);
    expect(total(page, 'wager_wallet_lock_wait_seconds_bucket', { le: '+Inf' })).toBe(4);
  });

  test('o que não aconteceu fica em zero (retries, conflitos de lock, DLQ, divergência)', () => {
    for (const name of ['wager_retries_total', 'wager_lock_conflicts_total', 'wager_dlq_messages_total', 'wager_reconciliation_divergence_total']) {
      expect(total(page, name)).toBe(0);
    }
  });

  test('os labels têm cardinalidade fixa: só status e kind, nunca ids', () => {
    const labelNames = new Set(page.samples.filter((s) => s.name === 'wager_transactions_total').flatMap((s) => Object.keys(s.labels)));
    expect([...labelNames].sort()).toEqual(['kind', 'status']);
  });
});

describe('wager_outbox_lag_seconds', () => {
  test('sem evento pendente é 0', async () => {
    await parkOutbox(probe);
    expect(total(await scrape(api), 'wager_outbox_lag_seconds')).toBe(0);
  });

  test('com evento pendente é a idade do mais antigo não publicado (medida no scrape, não guardada)', async () => {
    await parkOutbox(probe);
    const id = uuid();
    await probe.query(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       values ($1, $2, 'WagerTransactionProcessed', '{}'::jsonb, now() - interval '90 seconds', now() - interval '90 seconds')`,
      [id, uuid()],
    );
    const lag = total(await scrape(api), 'wager_outbox_lag_seconds');
    expect(lag).toBeGreaterThanOrEqual(90);
    expect(lag).toBeLessThan(150);

    await parkOutbox(probe); // publicado: o lag volta a zero
    expect(total(await scrape(api), 'wager_outbox_lag_seconds')).toBe(0);
  });
});
