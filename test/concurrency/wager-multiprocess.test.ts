// Cenário #4: 3 PROCESSOS reais (child_process), cada um com sua instância da aplicação e seu pool, contra o mesmo Postgres.
// Nenhum estado de correção em memória: a corretude vem do banco (UNIQUE + lock da wallet).
// A simultaneidade é PROVADA: o teste segura o lock das wallets até ver requisições dos 3 processos esperando por ele ao mesmo tempo.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { waitFor } from '../support/sqs';
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

interface Child {
  /** Resolve quando a instância do filho está no ar e aguardando o `GO`. */
  ready: Promise<void>;
  go(): void;
  /** Respostas na mesma ordem dos `jobs`. */
  outcomes: Promise<Outcome[]>;
  kill(): void;
}

/** Sobe um processo `bun` que carrega `jobs`, avisa `READY` e só dispara as requisições depois do `GO`. */
function spawnChild(jobs: Job[], applicationName: string): Child {
  const child = spawn(process.execPath, ['run', 'test/support/wager-worker.ts'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    // PGAPPNAME identifica no pg_stat_activity as conexões deste processo; o lock_timeout longo o mantém esperando o lock segurado pelo teste.
    env: { ...process.env, PGAPPNAME: applicationName, LOCK_TIMEOUT_MS: '60000' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const outcomes = new Promise<Outcome[]>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
      if (code !== 0 || line === undefined) reject(new Error(`processo filho falhou (code=${code}): ${stderr.slice(0, 500)}`));
      else resolve(JSON.parse(line.slice('RESULT:'.length)) as Outcome[]);
    });
  });
  outcomes.catch(() => undefined); // quem espera trata o erro; isto evita rejeição solta se o teste falhar antes
  child.stdin.write(`${JSON.stringify(jobs)}\n`);
  return {
    ready: waitFor('filho pronto', () => {
      if (child.exitCode !== null) throw new Error(`processo filho terminou antes do READY: ${stderr.slice(0, 500)}`);
      return stdout.includes('READY');
    }, 30_000),
    go: () => { child.stdin.end('GO\n'); },
    outcomes,
    kill: () => { child.kill('SIGKILL'); },
  };
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
  const run = `w4-${uuid().slice(0, 8)}`;
  const children: Child[] = [];
  const holder = await probe.connect();
  let outcomes: Outcome[][];
  try {
    await holder.query('BEGIN');
    await holder.query('select id from wallets where id = any($1) for no key update', [[walletA.walletId, walletB.walletId]]);
    children.push(...batches.map((jobs, index) => spawnChild(jobs, `${run}-${index}`)));
    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.go();

    // Prova de simultaneidade: os 3 processos têm, no mesmo instante, requisições paradas no lock.
    await waitFor(`requisições dos ${PROCESSES} processos esperando o lock ao mesmo tempo`, async () => {
      const { rows } = await probe.query<{ n: string }>(
        "select count(distinct application_name)::text as n from pg_stat_activity where wait_event_type = 'Lock' and application_name like $1", [`${run}-%`]);
      return rows[0]?.n === String(PROCESSES);
    }, 30_000);

    await holder.query('ROLLBACK');
    outcomes = await Promise.all(children.map((child) => child.outcomes));
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    for (const child of children) child.kill();
  }
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
