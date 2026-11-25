// Cenário #4: 3 PROCESSOS reais (child_process), cada um com sua instância da aplicação e seu pool, contra o mesmo Postgres.
// Nenhum estado de correção em memória: a corretude vem do banco (UNIQUE + lock da wallet).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { defaultKey, openWallet, wagerPayload } from '../support/wager';

const PROCESSES = 3;
const probe = createProbe(4);
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi(); // só para abrir as wallets; as apostas vêm dos processos filhos
});
afterAll(async () => {
  await api.close();
  await probe.end();
});

interface Job {
  payload: ReturnType<typeof wagerPayload>;
  key: string;
}
interface Outcome {
  status: number;
  body: { transactionId: string; status: string; idempotentReplay: boolean; failureCode?: string };
}

/** Sobe um processo `bun` que executa `jobs` e devolve as respostas na mesma ordem. */
function runChild(jobs: Job[]): Promise<Outcome[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['run', 'test/support/wager-worker.ts'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
      if (code !== 0 || line === undefined) reject(new Error(`processo filho falhou (code=${code}): ${stderr.slice(0, 500)}`));
      else resolve(JSON.parse(line.slice('RESULT:'.length)) as Outcome[]);
    });
    child.stdin.end(JSON.stringify(jobs));
  });
}

const money = (amount: string) => ({ amount, currency: 'BRL' });
const job = (payload: ReturnType<typeof wagerPayload>): Job => ({ payload, key: defaultKey(payload) });

test(`#4 ${PROCESSES} processos reais: mesmas apostas em todos, saldo disputado em outra wallet; invariantes mantidas`, async () => {
  // Wallet A: 30 BETs de 10,00 (saldo 1000,00); cada processo envia as 30 => cada uma deve ser debitada 1 única vez.
  const walletA = await openWallet(api, '1000.00');
  const sharedBets = Array.from({ length: 30 }, () => wagerPayload(walletA, { money: money('10.00') }));

  // Wallet B: saldo 100,00; cada processo envia 10 BETs próprias de 30,00 (30 disputando) => só 3 cabem.
  const walletB = await openWallet(api, '100.00');
  const ownBets = (): ReturnType<typeof wagerPayload>[] => Array.from({ length: 10 }, () => wagerPayload(walletB, { money: money('30.00') }));

  const batches = Array.from({ length: PROCESSES }, () => [...sharedBets.map(job), ...ownBets().map(job)]);
  const outcomes = await Promise.all(batches.map(runChild));
  const all = outcomes.flat();

  // Nada de 5xx/503: só 201 (processada ou replay) e 422 (rejeição de negócio).
  expect(all.every((o) => o.status === 201 || o.status === 422)).toBe(true);

  // Wallet A: cada BET compartilhada tem exatamente 1 execução original entre todos os processos.
  for (const bet of sharedBets) {
    const { rows } = await probe.query<{ id: string }>('select id from wager_transactions where provider_id = $1 and external_transaction_id = $2', [bet.providerId, bet.externalTransactionId]);
    expect(rows).toHaveLength(1);
    const copies = outcomes.flatMap((batch) => batch.filter((o) => o.body.transactionId === rows[0]?.id));
    expect(copies).toHaveLength(PROCESSES);
    expect(copies.filter((o) => !o.body.idempotentReplay)).toHaveLength(1);
    expect(copies.every((o) => o.status === 201)).toBe(true);
  }
  expect(await ledgerBalance(probe, walletA.walletId)).toEqual({ stored: '700.00', rebuilt: '700.00', entries: 31 });

  // Wallet B: exatamente 3 apostas de 30,00 passam, as outras 27 são rejeitadas por saldo; saldo 10,00.
  const { rows: statuses } = await probe.query<{ status: string; n: string }>(
    'select status, count(*)::text as n from wager_transactions where wallet_id = $1 and kind = $2 group by status order by status', [walletB.walletId, 'BET']);
  expect(statuses).toEqual([{ status: 'PROCESSED', n: '3' }, { status: 'REJECTED', n: '27' }]);
  expect(await ledgerBalance(probe, walletB.walletId)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 4 });
}, 90_000);
