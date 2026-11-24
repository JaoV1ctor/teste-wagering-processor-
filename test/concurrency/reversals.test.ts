// Concorrência de reversões e do worker de PENDING_REFERENCE (SPEC §3.1, §8.3, §10). Postgres REAL, paralelismo real (HTTP simultâneo
// e processos filhos). Invariante final em todos: wallet.balance == saldo reconstruído pelo ledger.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance, parkPendingReferences } from '../support/db';
import { defaultKey, openWallet, reversalPayload, submit, type WagerPayload, wagerPayload } from '../support/wager';

const probe = createProbe(4);
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });
const post = (payload: WagerPayload) => submit(api, payload, defaultKey(payload));
type Wallet = { walletId: string; playerId: string };

async function walletWithBet(balance = '100.00', bet = '30.00') {
  const wallet = await openWallet(api, balance);
  const payload = wagerPayload(wallet, { money: money(bet) });
  expect((await post(payload)).status).toBe(201);
  return { wallet, bet: payload };
}

const effectiveReversals = async (wallet: Wallet) =>
  (await probe.query<{ n: string }>(
    "select count(*)::text as n from wager_transactions where wallet_id = $1 and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'", [wallet.walletId],
  )).rows[0]?.n;

describe('reversões concorrentes da mesma transação: no máximo UMA efetiva (SPEC §3.1)', () => {
  test('REFUND e ROLLBACK da mesma BET ao mesmo tempo (20 rodadas): 1 PROCESSED, 1 REJECTED/ALREADY_REVERSED, crédito uma única vez', async () => {
    for (let round = 0; round < 20; round += 1) {
      const { wallet, bet } = await walletWithBet();
      const results = await Promise.all([post(reversalPayload(wallet, bet, 'REFUND')), post(reversalPayload(wallet, bet, 'ROLLBACK'))]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(results.find((r) => r.status === 422)?.body.failureCode).toBe('ALREADY_REVERSED');
      expect(await effectiveReversals(wallet)).toBe('1');
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 }); // OPENING + débito + UM crédito
    }
  });

  test('25 REFUNDs e 25 ROLLBACKs (ids externos diferentes) da mesma BET: exatamente 1 efetiva, 49 ALREADY_REVERSED, sem 5xx', async () => {
    const { wallet, bet } = await walletWithBet();
    const results = await Promise.all([
      ...Array.from({ length: 25 }, () => post(reversalPayload(wallet, bet, 'REFUND'))),
      ...Array.from({ length: 25 }, () => post(reversalPayload(wallet, bet, 'ROLLBACK'))),
    ]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 422);
    expect(rejected).toHaveLength(49);
    expect(rejected.every((r) => r.body.failureCode === 'ALREADY_REVERSED')).toBe(true);
    expect(await effectiveReversals(wallet)).toBe('1');
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('o MESMO REFUND x50 em paralelo: 1 crédito, 49 replays idênticos', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = reversalPayload(wallet, bet, 'REFUND');
    const results = await Promise.all(Array.from({ length: 50 }, () => post(refund)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    const firsts = results.filter((r) => r.body.idempotentReplay === false);
    expect(firsts).toHaveLength(1);
    for (const replay of results.filter((r) => r.body.idempotentReplay === true)) expect(replay.body).toEqual({ ...firsts[0]?.body, idempotentReplay: true });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('BET e seu REFUND disputando a mesma wallet com outras BETs: o saldo nunca fica negativo e fecha com o ledger', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('60.00') });
    expect((await post(bet)).status).toBe(201); // 40,00
    const others = Array.from({ length: 10 }, () => post(wagerPayload(wallet, { money: money('30.00') })));
    const results = await Promise.all([post(reversalPayload(wallet, bet, 'REFUND')), ...others]);

    expect(results.every((r) => r.status === 201 || r.status === 422)).toBe(true);
    const { stored, rebuilt } = await ledgerBalance(probe, wallet.walletId);
    expect(stored).toBe(rebuilt);
    expect(stored.startsWith('-')).toBe(false); // nunca negativo
  });
});

/** N pendentes em UMA wallet: N REFUNDs chegam antes das N BETs, que depois debitam e deixam o saldo em `initial - N*10`. */
async function pendingRefundsThenBets(count: number) {
  const wallet = await openWallet(api, '1000.00');
  const bets = Array.from({ length: count }, () => wagerPayload(wallet, { money: money('10.00') }));
  const refunds = await Promise.all(bets.map((bet) => post(reversalPayload(wallet, bet, 'REFUND'))));
  expect(refunds.every((r) => r.status === 202)).toBe(true);
  expect((await Promise.all(bets.map(post))).every((r) => r.status === 201)).toBe(true);
  return { wallet, refundIds: refunds.map((r) => r.body.transactionId as string) };
}

interface Totals { claimed: number; processed: number; rejected: number; rescheduled: number; skipped: number; failed: number }

/** Sobe um processo `bun` com um worker próprio e devolve os totais dele. */
function runWorkerProcess(): Promise<Totals> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['run', 'test/support/pending-worker-child.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLOCK_OFFSET_MS: '60000', WORKER_BATCH_SIZE: '5' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
      if (code !== 0 || line === undefined) reject(new Error(`worker filho falhou (code=${code}): ${stderr.slice(0, 500)}`));
      else resolve(JSON.parse(line.slice('RESULT:'.length)) as Totals);
    });
  });
}

describe('workers concorrentes do PENDING_REFERENCE: nenhuma transação é processada duas vezes', () => {
  beforeEach(() => parkPendingReferences(probe));

  test('3 PROCESSOS reais disputando 30 pendências: cada uma resolvida exatamente uma vez, 30 créditos, invariante do ledger', async () => {
    const { wallet, refundIds } = await pendingRefundsThenBets(30);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '700.00', rebuilt: '700.00', entries: 31 });

    const totals = await Promise.all([runWorkerProcess(), runWorkerProcess(), runWorkerProcess()]);
    const sum = (key: keyof Totals) => totals.reduce((acc, t) => acc + t[key], 0);

    expect(sum('claimed')).toBe(30); // as reivindicações dos 3 processos são disjuntas
    expect(sum('processed')).toBe(30);
    expect(sum('failed')).toBe(0);
    expect(sum('skipped')).toBe(0);
    const { rows } = await probe.query<{ status: string; n: string }>('select status, count(*)::text as n from wager_transactions where id = any($1) group by status', [refundIds]);
    expect(rows).toEqual([{ status: 'PROCESSED', n: '30' }]);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '1000.00', rebuilt: '1000.00', entries: 61 }); // OPENING + 30 débitos + 30 créditos
    expect(await effectiveReversals(wallet)).toBe('30');
  }, 90_000);

  test('worker e HTTP ao mesmo tempo na mesma wallet: reversões resolvidas pelo worker e novas apostas convivem sem perder consistência', async () => {
    const { wallet, refundIds } = await pendingRefundsThenBets(10);
    const live = Array.from({ length: 20 }, () => post(wagerPayload(wallet, { money: money('5.00') })));
    const [totals] = await Promise.all([runWorkerProcess(), ...live]);

    expect(totals.processed).toBe(10);
    const { rows } = await probe.query<{ status: string }>('select distinct status from wager_transactions where id = any($1)', [refundIds]);
    expect(rows).toEqual([{ status: 'PROCESSED' }]);
    const { stored, rebuilt } = await ledgerBalance(probe, wallet.walletId);
    expect(stored).toBe(rebuilt);
  }, 90_000);
});
