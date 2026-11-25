// Constraints, triggers e corridas do schema com SQL cru. Postgres REAL (docker compose), sem mocks.
//  - a ordem dos casos importa (alguns compartilham W/T);
//  - conexão vem de DATABASE_URL; schema aplicado via migration;
//  - o protótipo de corrida usa bigint em centavos (nunca number para dinheiro).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import pg from 'pg';
import { requireEnv } from '../../src/infrastructure/env';
import { type Orm, initOrm } from '../support/db';

const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 60 });
let orm: Orm;

beforeAll(async () => {
  orm = await initOrm();
  await orm.migrator.up(); // idempotente: aplica só se pendente
});
afterAll(async () => {
  await pool.end();
  await orm.close();
});

type Conn = pg.PoolClient;
type Wallet = { id: string; player: string; cur: string };
type TxResult = { ok: true } | { ok: false; err: Error };

// roda fn em transação (COMMIT real, para disparar os triggers deferidos)
async function tx(fn: (c: Conn) => Promise<unknown>): Promise<TxResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* conexão já abortada: o erro da transação é o que importa */ }
    return { ok: false, err: e as Error };
  } finally {
    c.release();
  }
}
const expectFail = (name: string, fn: (c: Conn) => Promise<unknown>, re?: RegExp) =>
  test(name, async () => {
    const r = await tx(fn);
    if (r.ok) throw new Error('deveria falhar e passou');
    if (re) expect(r.err.message).toMatch(re);
  });
const expectOk = (name: string, fn: (c: Conn) => Promise<unknown>) =>
  test(name, async () => {
    const r = await tx(fn);
    if (!r.ok) throw r.err;
  });

// ---- helpers de domínio (SQL cru, só para os testes de schema)
const mkWallet = async (c: Conn, balance = '0.00', cur = 'BRL'): Promise<Wallet> => {
  const id = uuid(), player = uuid();
  await c.query('INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1,$2,$3,$4)', [id, player, cur, balance]);
  return { id, player, cur };
};
type TxOpts = { kind?: string; amount?: string; status?: string; ref?: string | null; refId?: string | null; ext?: string; key?: string };
const mkTx = async (c: Conn, w: Wallet, o: TxOpts = {}): Promise<string> => {
  const id = uuid();
  const v = { kind: 'BET', amount: '10.00', status: 'PROCESSED', ref: null, refId: null, ...o };
  await c.query(`INSERT INTO wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
     kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, observed_balance, processed_at)
    VALUES ($1,'p',$2,$3,$4,$5,$6,'r1','g1',$7,$8,'BRL',$9,$10,$11,$12,$13,$14)`,
    [id, o.ext ?? id, o.key ?? id, 'a'.repeat(64), w.id, w.player, v.kind, v.amount, v.ref, v.refId, v.status,
     v.status === 'REJECTED' ? 'X' : null, v.status === 'PROCESSED' ? '0.00' : null, v.status === 'PROCESSED' ? new Date() : null]);
  return id;
};
const mkEntry = (c: Conn, w: Wallet, txId: string, dir: string, amount: string, before: string, after: string) => c.query(
  `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
   VALUES ($1,$2,$3,$4,$5,'BRL',$6,$7)`, [uuid(), w.id, txId, dir, amount, before, after]);

describe('Constraints básicas', () => {
  expectFail('saldo negativo é rejeitado (CHECK)', (c) => mkWallet(c, '-0.01'), /check/i);
  expectFail('wallet duplicada player+moeda é rejeitada', async (c) => {
    const w = await mkWallet(c); await c.query('INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1,$2,$3,0)', [uuid(), w.player, 'BRL']);
  }, /duplicate|unique/i);
  expectFail('wallet com saldo 1000 SEM ledger falha no COMMIT', (c) => mkWallet(c, '1000.00'), /divergente do ledger/);
  expectOk('wallet + OPENING + CREDIT na mesma transação passa', async (c) => {
    const w = await mkWallet(c, '1000.00'); const t = await mkTx(c, w, { kind: 'OPENING', amount: '1000.00' });
    await mkEntry(c, w, t, 'CREDIT', '1000.00', '0.00', '1000.00');
  });
  expectFail('moeda inválida (minúscula)', (c) => mkWallet(c, '0.00', 'brl'), /check/i);
});

describe('Ledger imutável e encadeado, wallet: version e consistência (estado compartilhado, ordem importa)', () => {
  let W!: Wallet;
  let T!: string;
  expectOk('prepara wallet 100.00', async (c) => {
    W = await mkWallet(c, '100.00'); T = await mkTx(c, W, { kind: 'OPENING', amount: '100.00' });
    await mkEntry(c, W, T, 'CREDIT', '100.00', '0.00', '100.00');
  });
  expectFail('UPDATE no ledger é proibido', (c) => c.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [W.id]), /imutável/);
  expectFail('DELETE no ledger é proibido', (c) => c.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [W.id]), /imutável/);
  expectFail('TRUNCATE no ledger é proibido', (c) => c.query(`TRUNCATE wallet_ledger_entries`), /imutável/);
  expectFail('lançamento com aritmética errada (CHECK)', async (c) => {
    const t = await mkTx(c, W); await mkEntry(c, W, t, 'DEBIT', '10.00', '100.00', '95.00');
  }, /check/i);
  expectFail('cadeia quebrada (balance_before errado)', async (c) => {
    const t = await mkTx(c, W); await mkEntry(c, W, t, 'DEBIT', '10.00', '50.00', '40.00');
  }, /cadeia quebrada/);
  expectFail('moeda do lançamento diferente da wallet (FK composta)', async (c) => {
    const t = await mkTx(c, W);
    await c.query(`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
                   VALUES ($1,$2,$3,'DEBIT',10,'USD',100,90)`, [uuid(), W.id, t]);
  }, /foreign key/i);
  expectFail('2 lançamentos da mesma transação na mesma wallet', async (c) => {
    const t = await mkTx(c, W);
    await c.query('UPDATE wallets SET balance = 90, version = version + 1 WHERE id = $1', [W.id]);
    await mkEntry(c, W, t, 'DEBIT', '10.00', '100.00', '90.00'); await mkEntry(c, W, t, 'DEBIT', '10.00', '90.00', '80.00');
  }, /duplicate|unique/i);
  expectFail('saldo mudou sem incrementar version', (c) => c.query('UPDATE wallets SET balance = 90 WHERE id = $1', [W.id]), /version/);
  expectFail('version mudou sem o saldo mudar', (c) => c.query('UPDATE wallets SET version = version + 1 WHERE id = $1', [W.id]), /version/);
  expectFail('saldo alterado SEM lançamento falha no COMMIT', (c) => c.query('UPDATE wallets SET balance = 90, version = version + 1 WHERE id = $1', [W.id]), /divergente do ledger/);
  expectFail('DELETE de wallet é proibido', (c) => c.query('DELETE FROM wallets WHERE id = $1', [W.id]), /proibido/);
  expectOk('débito correto (wallet+ledger+version) passa', async (c) => {
    const t = await mkTx(c, W);
    await c.query('UPDATE wallets SET balance = 90, version = version + 1 WHERE id = $1', [W.id]);
    await mkEntry(c, W, t, 'DEBIT', '10.00', '100.00', '90.00');
  });
});

describe('Idempotência, estados terminais e reversão única', () => {
  expectFail('mesma idempotency_key duas vezes', async (c) => {
    const w = await mkWallet(c); const k = uuid(); await mkTx(c, w, { key: k, status: 'PENDING' }); await mkTx(c, w, { key: k, status: 'PENDING' });
  }, /duplicate|unique/i);
  expectFail('mesmo (provider, externalTransactionId) com outra key', async (c) => {
    const w = await mkWallet(c); const e = uuid(); await mkTx(c, w, { ext: e, status: 'PENDING' }); await mkTx(c, w, { ext: e, status: 'PENDING' });
  }, /duplicate|unique/i);
  expectFail('transação terminal não pode ser alterada', async (c) => {
    const w = await mkWallet(c); const t = await mkTx(c, w, { status: 'REJECTED' });
    await c.query(`UPDATE wager_transactions SET status = 'PROCESSED' WHERE id = $1`, [t]);
  }, /terminal/);
  expectFail('DELETE de transação é proibido', async (c) => {
    const w = await mkWallet(c); const t = await mkTx(c, w, { status: 'PENDING' }); await c.query('DELETE FROM wager_transactions WHERE id = $1', [t]);
  }, /proibido/);
  expectFail('PENDING_REFERENCE não volta a PENDING', async (c) => {
    const w = await mkWallet(c); const t = await mkTx(c, w, { status: 'PENDING_REFERENCE', kind: 'REFUND', ref: 'x' });
    await c.query(`UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`, [t]);
  }, /inválida/);
  expectFail('REFUND sem referência (CHECK)', async (c) => { const w = await mkWallet(c); await mkTx(c, w, { kind: 'REFUND', status: 'PENDING' }); }, /check/i);
  expectFail('REJECTED sem failure_code (CHECK)', async (c) => {
    const w = await mkWallet(c);
    await c.query(`INSERT INTO wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
      VALUES ($1::uuid,'p',$1::text,$1::text,$2,$3,$4,'r','g','BET',1,'BRL','REJECTED')`, [uuid(), 'a'.repeat(64), w.id, w.player]);
  }, /check/i);
  expectFail('REFUND + ROLLBACK efetivos na mesma BET (crédito duplicado)', async (c) => {
    const w = await mkWallet(c); const bet = await mkTx(c, w, { kind: 'BET' });
    await mkTx(c, w, { kind: 'REFUND', ref: 'b', refId: bet });
    await mkTx(c, w, { kind: 'ROLLBACK', ref: 'b', refId: bet });
  }, /duplicate|unique/i);
  expectOk('REJECTED não conta como reversão (pode haver 1 rejeitada + 1 processada)', async (c) => {
    const w = await mkWallet(c); const bet = await mkTx(c, w, { kind: 'BET' });
    await mkTx(c, w, { kind: 'ROLLBACK', ref: 'b', refId: bet, status: 'REJECTED' });
    await mkTx(c, w, { kind: 'REFUND', ref: 'b', refId: bet });
  });
});

// ---------------------------------------------------------------------------
// CORRIDAS REAIS (conexões paralelas). Protótipo do caso de uso (SQL cru): valida o PADRÃO de lock.
// Dinheiro em bigint (centavos) mesmo aqui; "100.00" <-> 10000n.
const toCents = (s: string): bigint => BigInt(s.replace('.', ''));
const fromCents = (n: bigint): string => `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;

type BetResult = { replay?: true; status?: string; error?: string };
type BetOpts = { lock?: boolean; order?: 'lock-first' | 'insert-first'; mode?: string };

async function processBet(w: Wallet, key: string, amount: string, { lock = true, order = 'lock-first', mode = 'FOR UPDATE' }: BetOpts = {}): Promise<BetResult> {
  // Fast-path de idempotência: leitura SEM lock e sem tocar a wallet; resolve replays já commitados.
  if (order === 'lock-first') {
    const ex = await pool.query('SELECT 1 FROM wager_transactions WHERE idempotency_key = $1', [key]);
    if (ex.rowCount) return { replay: true };
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = uuid();
    const insertTx = () => c.query(`INSERT INTO wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
      VALUES ($1,'p',$2,$2,$3,$4,$5,'r','g','BET',$6,'BRL','PENDING') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, key, 'b'.repeat(64), w.id, w.player, amount]);
    const lockWallet = () => c.query<{ balance: string; version: number }>(`SELECT balance, version FROM wallets WHERE id = $1 ${lock ? mode : ''}`, [w.id]);
    let r;
    if (order === 'lock-first') {            // REGRA: wallet PRIMEIRO, depois transação, ledger, outbox
      r = await lockWallet();
      if (!(await insertTx()).rowCount) { await c.query('COMMIT'); return { replay: true }; }
    } else {                                  // ANTI-PADRÃO (só para demonstrar o deadlock)
      if (!(await insertTx()).rowCount) { await c.query('COMMIT'); return { replay: true }; }
      r = await lockWallet();
    }
    const row = r.rows[0]!;
    const bal = toCents(row.balance), amt = toCents(amount);
    if (bal < amt) {
      await c.query(`UPDATE wager_transactions SET status='REJECTED', failure_code='INSUFFICIENT_BALANCE', observed_balance=$2 WHERE id=$1`, [id, fromCents(bal)]);
      await c.query('COMMIT'); return { status: 'REJECTED' };
    }
    const after = fromCents(bal - amt);
    await mkEntry(c, w, id, 'DEBIT', amount, fromCents(bal), after);
    await c.query('UPDATE wallets SET balance = $2, version = $3 WHERE id = $1', [w.id, after, row.version + 1]);
    await c.query(`UPDATE wager_transactions SET status='PROCESSED', observed_balance=$2, processed_at=now() WHERE id=$1`, [id, after]);
    await c.query('COMMIT'); return { status: 'PROCESSED' };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* o erro da transação é o relevante */ }
    return { error: (e as Error).message };
  } finally { c.release(); }
}
const openWallet = async (amount: string): Promise<Wallet> => {
  let w!: Wallet;
  const r = await tx(async (c) => { w = await mkWallet(c, amount); const t = await mkTx(c, w, { kind: 'OPENING', amount }); await mkEntry(c, w, t, 'CREDIT', amount, '0.00', amount); });
  if (!r.ok) throw r.err;
  return w;
};
const snapshot = async (w: Wallet) => {
  const a = await pool.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id=$1', [w.id]);
  const l = await pool.query<{ debits: string; rebuilt: string }>(`SELECT count(*) FILTER (WHERE direction='DEBIT') AS debits, COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) AS rebuilt FROM wallet_ledger_entries WHERE wallet_id=$1`, [w.id]);
  return { balance: a.rows[0]!.balance, version: a.rows[0]!.version, debits: Number(l.rows[0]!.debits), rebuilt: l.rows[0]!.rebuilt };
};

describe('CORRIDAS REAIS (conexões paralelas)', () => {
  test('cenário obrigatório: 2 apostas de 80 em saldo 100 → PROCESSED+REJECTED, saldo 20.00, 1 débito', async () => {
    const w = await openWallet('100.00');
    const res = await Promise.all([processBet(w, uuid(), '80.00'), processBet(w, uuid(), '80.00')]);
    const s = await snapshot(w); const st = res.map((r) => r.status).sort();
    expect(st).toEqual(['PROCESSED', 'REJECTED']);
    expect(s.balance).toBe('20.00');
    expect(s.debits).toBe(1);
    expect(s.rebuilt).toBe(s.balance);
  });

  test('#1: 50 envios paralelos da mesma aposta → 1 processada, 49 replays, saldo 90.00, 1 débito', async () => {
    const w = await openWallet('100.00'); const key = uuid();
    const res = await Promise.all(Array.from({ length: 50 }, () => processBet(w, key, '10.00')));
    const s = await snapshot(w);
    expect(res.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(res.filter((r) => r.replay)).toHaveLength(49);
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(s.balance).toBe('90.00');
    expect(s.debits).toBe(1);
    expect(s.rebuilt).toBe(s.balance);
  });

  test('hot wallet: 30 apostas de 10 distintas em saldo 100 → exatamente 10 processadas, saldo 0.00, version 11', async () => {
    const w = await openWallet('100.00');
    const res = await Promise.all(Array.from({ length: 30 }, () => processBet(w, uuid(), '10.00')));
    const s = await snapshot(w);
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(res.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(s.balance).toBe('0.00');
    expect(s.debits).toBe(10);
    expect(s.rebuilt).toBe(s.balance);
    expect(s.version).toBe(11);
  });

  // Imprime a comparação entre as ordens de lock e trava a REGRA: 0 deadlocks e estado consistente.
  test('ordem de lock: anti-padrão vs regra (3 rodadas de 30 apostas na mesma wallet)', async () => {
    const report: Record<string, { dead: number; procs: number; consistent: boolean }> = {};
    for (const [label, opts] of [
      ['ANTI-PADRÃO  insert -> FOR UPDATE        ', { order: 'insert-first', mode: 'FOR UPDATE' }],
      ['alternativa insert -> FOR NO KEY UPDATE  ', { order: 'insert-first', mode: 'FOR NO KEY UPDATE' }],
      ['REGRA        lock -> insert (FOR UPDATE) ', { order: 'lock-first', mode: 'FOR UPDATE' }],
    ] as const) {
      let dead = 0, procs = 0, consistent = true;
      for (let round = 0; round < 3; round++) {
        const w = await openWallet('100.00');
        const res = await Promise.all(Array.from({ length: 30 }, () => processBet(w, uuid(), '10.00', opts)));
        dead += res.filter((r) => /deadlock/.test(r.error ?? '')).length; procs += res.filter((r) => r.status === 'PROCESSED').length;
        const s = await snapshot(w); consistent &&= s.rebuilt === s.balance;
      }
      report[label] = { dead, procs, consistent };
    }
    const regra = report['REGRA        lock -> insert (FOR UPDATE) ']!;
    expect(regra.dead).toBe(0);
    expect(regra.procs).toBe(30); // 10 por rodada × 3
    expect(regra.consistent).toBe(true);
  }, 120_000); // o anti-padrão espera deadlock_timeout (1s) várias vezes, acima do limite padrão de 5 s

  test('20 wallets distintas em paralelo, todas consistentes', async () => {
    const ws = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
    const res = await Promise.all(ws.map((w) => processBet(w, uuid(), '40.00')));
    const all = await Promise.all(ws.map(snapshot));
    expect(res.every((r) => r.status === 'PROCESSED')).toBe(true);
    expect(all.every((s) => s.balance === '60.00' && s.rebuilt === s.balance)).toBe(true);
  });

  test('CONTROLE NEGATIVO (SEM lock): o banco aborta um dos dois; 1 débito; ledger reconstrói o saldo', async () => {
    const w = await openWallet('100.00');
    const res = await Promise.all([processBet(w, uuid(), '80.00', { lock: false }), processBet(w, uuid(), '80.00', { lock: false })]);
    const s = await snapshot(w); const errs = res.filter((r) => r.error);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0]!.error).toMatch(/lost update|serializ|deadlock|divergente|cadeia/i);
    expect(s.debits).toBe(1);
    expect(s.rebuilt).toBe(s.balance);
  });
});
