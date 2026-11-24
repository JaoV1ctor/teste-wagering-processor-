// Testes do schema contra Postgres REAL. Cada caso roda em transação própria (COMMIT real,
// para disparar os triggers deferidos). Esperamos sucesso ou falha específica.
import pg from 'pg';
import { randomUUID as uuid } from 'node:crypto';
const cfg = { host: 'localhost', port: 54329, user: 'postgres', password: 'postgres', database: 'wager' };
const pool = new pg.Pool({ ...cfg, max: 60 });
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS', n); };
const bad = (n, why) => { fail++; console.log('  FAIL', n, '->', why); };

async function tx(fn) { // roda fn em transação; devolve {ok} ou {err}
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); return { ok: true }; }
  catch (e) { try { await c.query('ROLLBACK'); } catch {} return { err: e }; }
  finally { c.release(); }
}
const expectFail = async (name, fn, re) => {
  const r = await tx(fn);
  if (r.ok) return bad(name, 'deveria falhar e passou');
  re && !re.test(r.err.message) ? bad(name, 'falhou com outra msg: ' + r.err.message) : ok(`${name}  [${r.err.message.slice(0, 70)}]`);
};
const expectOk = async (name, fn) => { const r = await tx(fn); r.ok ? ok(name) : bad(name, r.err.message); };

// ---- helpers de domínio (SQL cru, só para os testes de schema)
const mkWallet = async (c, balance = '0.00', cur = 'BRL') => {
  const id = uuid(), player = uuid();
  await c.query('INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1,$2,$3,$4)', [id, player, cur, balance]);
  return { id, player, cur };
};
const mkTx = async (c, w, o = {}) => {
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
const mkEntry = (c, w, txId, dir, amount, before, after) => c.query(
  `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
   VALUES ($1,$2,$3,$4,$5,'BRL',$6,$7)`, [uuid(), w.id, txId, dir, amount, before, after]);

console.log('\n== Constraints básicas ==');
await expectFail('saldo negativo é rejeitado (CHECK)', (c) => mkWallet(c, '-0.01'), /check/i);
await expectFail('wallet duplicada player+moeda é rejeitada', async (c) => {
  const w = await mkWallet(c); await c.query('INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1,$2,$3,0)', [uuid(), w.player, 'BRL']);
}, /duplicate|unique/i);
await expectFail('wallet com saldo 1000 SEM ledger falha no COMMIT', (c) => mkWallet(c, '1000.00'), /divergente do ledger/);
await expectOk('wallet + OPENING + CREDIT na mesma transação passa', async (c) => {
  const w = await mkWallet(c, '1000.00'); const t = await mkTx(c, w, { kind: 'OPENING', amount: '1000.00' });
  await mkEntry(c, w, t, 'CREDIT', '1000.00', '0.00', '1000.00');
});
await expectFail('moeda inválida (minúscula)', (c) => mkWallet(c, '0.00', 'brl'), /check/i);

console.log('\n== Ledger imutável e encadeado ==');
let W, T;
await expectOk('prepara wallet 100.00', async (c) => {
  W = await mkWallet(c, '100.00'); T = await mkTx(c, W, { kind: 'OPENING', amount: '100.00' });
  await mkEntry(c, W, T, 'CREDIT', '100.00', '0.00', '100.00');
});
await expectFail('UPDATE no ledger é proibido', (c) => c.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [W.id]), /imutável/);
await expectFail('DELETE no ledger é proibido', (c) => c.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [W.id]), /imutável/);
await expectFail('TRUNCATE no ledger é proibido', (c) => c.query(`TRUNCATE wallet_ledger_entries`), /imutável/);
await expectFail('lançamento com aritmética errada (CHECK)', async (c) => {
  const t = await mkTx(c, W); await mkEntry(c, W, t, 'DEBIT', '10.00', '100.00', '95.00');
}, /check/i);
await expectFail('cadeia quebrada (balance_before errado)', async (c) => {
  const t = await mkTx(c, W); await mkEntry(c, W, t, 'DEBIT', '10.00', '50.00', '40.00');
}, /cadeia quebrada/);
await expectFail('moeda do lançamento diferente da wallet (FK composta)', async (c) => {
  const t = await mkTx(c, W);
  await c.query(`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
                 VALUES ($1,$2,$3,'DEBIT',10,'USD',100,90)`, [uuid(), W.id, t]);
}, /foreign key/i);
await expectFail('2 lançamentos da mesma transação na mesma wallet', async (c) => {
  const t = await mkTx(c, W);
  await c.query('UPDATE wallets SET balance = 90, version = version + 1 WHERE id = $1', [W.id]);
  await mkEntry(c, W, t, 'DEBIT', '10.00', '100.00', '90.00'); await mkEntry(c, W, t, 'DEBIT', '10.00', '90.00', '80.00');
}, /duplicate|unique/i);

console.log('\n== Wallet: version e consistência com o ledger ==');
await expectFail('saldo mudou sem incrementar version', (c) => c.query('UPDATE wallets SET balance = 90 WHERE id = $1', [W.id]), /version/);
await expectFail('version mudou sem o saldo mudar', (c) => c.query('UPDATE wallets SET version = version + 1 WHERE id = $1', [W.id]), /version/);
await expectFail('saldo alterado SEM lançamento falha no COMMIT', (c) => c.query('UPDATE wallets SET balance = 90, version = version + 1 WHERE id = $1', [W.id]), /divergente do ledger/);
await expectFail('DELETE de wallet é proibido', (c) => c.query('DELETE FROM wallets WHERE id = $1', [W.id]), /proibido/);
await expectOk('débito correto (wallet+ledger+version) passa', async (c) => {
  const t = await mkTx(c, W);
  await c.query('UPDATE wallets SET balance = 90, version = version + 1 WHERE id = $1', [W.id]);
  await mkEntry(c, W, t, 'DEBIT', '10.00', '100.00', '90.00');
});

console.log('\n== Idempotência, estados terminais e reversão única ==');
await expectFail('mesma idempotency_key duas vezes', async (c) => {
  const w = await mkWallet(c); const k = uuid(); await mkTx(c, w, { key: k, status: 'PENDING' }); await mkTx(c, w, { key: k, status: 'PENDING' });
}, /duplicate|unique/i);
await expectFail('mesmo (provider, externalTransactionId) com outra key', async (c) => {
  const w = await mkWallet(c); const e = uuid(); await mkTx(c, w, { ext: e, status: 'PENDING' }); await mkTx(c, w, { ext: e, status: 'PENDING' });
}, /duplicate|unique/i);
await expectFail('transação terminal não pode ser alterada', async (c) => {
  const w = await mkWallet(c); const t = await mkTx(c, w, { status: 'REJECTED' });
  await c.query(`UPDATE wager_transactions SET status = 'PROCESSED' WHERE id = $1`, [t]);
}, /terminal/);
await expectFail('DELETE de transação é proibido', async (c) => {
  const w = await mkWallet(c); const t = await mkTx(c, w, { status: 'PENDING' }); await c.query('DELETE FROM wager_transactions WHERE id = $1', [t]);
}, /proibido/);
await expectFail('PENDING_REFERENCE não volta a PENDING', async (c) => {
  const w = await mkWallet(c); const t = await mkTx(c, w, { status: 'PENDING_REFERENCE', kind: 'REFUND', ref: 'x' });
  await c.query(`UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`, [t]);
}, /inválida/);
await expectFail('REFUND sem referência (CHECK)', async (c) => { const w = await mkWallet(c); await mkTx(c, w, { kind: 'REFUND', status: 'PENDING' }); }, /check/i);
await expectFail('REJECTED sem failure_code (CHECK)', async (c) => {
  const w = await mkWallet(c);
  await c.query(`INSERT INTO wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
    VALUES ($1::uuid,'p',$1::text,$1::text,$2,$3,$4,'r','g','BET',1,'BRL','REJECTED')`, [uuid(), 'a'.repeat(64), w.id, w.player]);
}, /check/i);
await expectFail('REFUND + ROLLBACK efetivos na mesma BET (crédito duplicado)', async (c) => {
  const w = await mkWallet(c); const bet = await mkTx(c, w, { kind: 'BET' });
  await mkTx(c, w, { kind: 'REFUND', ref: 'b', refId: bet });
  await mkTx(c, w, { kind: 'ROLLBACK', ref: 'b', refId: bet });
}, /duplicate|unique/i);
await expectOk('REJECTED não conta como reversão (pode haver 1 rejeitada + 1 processada)', async (c) => {
  const w = await mkWallet(c); const bet = await mkTx(c, w, { kind: 'BET' });
  await mkTx(c, w, { kind: 'ROLLBACK', ref: 'b', refId: bet, status: 'REJECTED' });
  await mkTx(c, w, { kind: 'REFUND', ref: 'b', refId: bet });
});

// ---------------------------------------------------------------------------
console.log('\n== CORRIDAS REAIS (conexões paralelas) ==');
// Protótipo do caso de uso (SQL cru) — valida o PADRÃO que a Fase 2 vai implementar no NestJS.
async function processBet(w, key, amount, { lock = true, order = 'lock-first', mode = 'FOR UPDATE' } = {}) {
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
    const lockWallet = () => c.query(`SELECT balance, version FROM wallets WHERE id = $1 ${lock ? mode : ''}`, [w.id]);
    let r;
    if (order === 'lock-first') {            // REGRA: wallet PRIMEIRO, depois transação, ledger, outbox
      r = await lockWallet();
      if (!(await insertTx()).rowCount) { await c.query('COMMIT'); return { replay: true }; }
    } else {                                  // ANTI-PADRÃO (só para demonstrar o deadlock)
      if (!(await insertTx()).rowCount) { await c.query('COMMIT'); return { replay: true }; }
      r = await lockWallet();
    }
    const bal = Number(r.rows[0].balance), amt = Number(amount); // (só no teste; no código real: Money/bigint)
    if (bal < amt) {
      await c.query(`UPDATE wager_transactions SET status='REJECTED', failure_code='INSUFFICIENT_BALANCE', observed_balance=$2 WHERE id=$1`, [id, bal.toFixed(2)]);
      await c.query('COMMIT'); return { status: 'REJECTED' };
    }
    const after = (bal - amt).toFixed(2);
    await mkEntry(c, w, id, 'DEBIT', amount, bal.toFixed(2), after);
    await c.query('UPDATE wallets SET balance = $2, version = $3 WHERE id = $1', [w.id, after, r.rows[0].version + 1]);
    await c.query(`UPDATE wager_transactions SET status='PROCESSED', observed_balance=$2, processed_at=now() WHERE id=$1`, [id, after]);
    await c.query('COMMIT'); return { status: 'PROCESSED' };
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} return { error: e.message }; }
  finally { c.release(); }
}
const openWallet = async (amount) => { let w; await tx(async (c) => { w = await mkWallet(c, amount); const t = await mkTx(c, w, { kind: 'OPENING', amount }); await mkEntry(c, w, t, 'CREDIT', amount, '0.00', amount); }); return w; };
const snapshot = async (w) => {
  const a = await pool.query('SELECT balance, version FROM wallets WHERE id=$1', [w.id]);
  const l = await pool.query(`SELECT count(*) FILTER (WHERE direction='DEBIT') AS debits, COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) AS rebuilt FROM wallet_ledger_entries WHERE wallet_id=$1`, [w.id]);
  return { balance: a.rows[0].balance, version: a.rows[0].version, debits: Number(l.rows[0].debits), rebuilt: l.rows[0].rebuilt };
};

{ // CENÁRIO OBRIGATÓRIO DO README (§8)
  const w = await openWallet('100.00');
  const res = await Promise.all([processBet(w, uuid(), '80.00'), processBet(w, uuid(), '80.00')]);
  const s = await snapshot(w); const st = res.map((r) => r.status).sort();
  (st[0] === 'PROCESSED' && st[1] === 'REJECTED' && s.balance === '20.00' && s.debits === 1 && s.rebuilt === s.balance)
    ? ok(`§8: 2 apostas de 80 em saldo 100 → ${st.join('+')}, saldo ${s.balance}, ${s.debits} débito, ledger reconstrói ${s.rebuilt}`)
    : bad('§8 cenário obrigatório', JSON.stringify({ res, s }));
}
{ // 50 envios paralelos da MESMA aposta (§13 concorrência #1)
  const w = await openWallet('100.00'); const key = uuid();
  const res = await Promise.all(Array.from({ length: 50 }, () => processBet(w, key, '10.00')));
  const s = await snapshot(w); const replays = res.filter((r) => r.replay).length, procs = res.filter((r) => r.status === 'PROCESSED').length;
  (procs === 1 && replays === 49 && s.balance === '90.00' && s.debits === 1 && s.rebuilt === s.balance)
    ? ok(`§13#1: 50 envios paralelos da mesma aposta → 1 processada, 49 replays, saldo ${s.balance}, ${s.debits} débito`)
    : bad('§13#1 50 paralelos', JSON.stringify({ procs, replays, s, errs: res.filter(r=>r.error).slice(0,2) }));
}
{ // Hot wallet: 30 apostas de 10 distintas em saldo 100 → exatamente 10 passam
  const w = await openWallet('100.00');
  const res = await Promise.all(Array.from({ length: 30 }, () => processBet(w, uuid(), '10.00')));
  const s = await snapshot(w); const procs = res.filter((r) => r.status === 'PROCESSED').length;
  (procs === 10 && s.balance === '0.00' && s.debits === 10 && s.rebuilt === s.balance && s.version === 11)
    ? ok(`hot wallet: 30 apostas de 10 em saldo 100 → ${procs} processadas, saldo ${s.balance}, version ${s.version}`)
    : bad('hot wallet', JSON.stringify({ procs, s, errs: res.filter(r=>r.error).slice(0,2) }));
}

console.log('\n== Por que a ORDEM DE LOCK é regra (informativo, 3 rodadas de 30 apostas na mesma wallet) ==');
for (const [label, opts] of [
  ['ANTI-PADRÃO  insert -> FOR UPDATE        ', { order: 'insert-first', mode: 'FOR UPDATE' }],
  ['alternativa insert -> FOR NO KEY UPDATE  ', { order: 'insert-first', mode: 'FOR NO KEY UPDATE' }],
  ['REGRA        lock -> insert (FOR UPDATE) ', { order: 'lock-first', mode: 'FOR UPDATE' }],
]) {
  let dead = 0, procs = 0, okState = true;
  for (let round = 0; round < 3; round++) {
    const w = await openWallet('100.00');
    const res = await Promise.all(Array.from({ length: 30 }, () => processBet(w, uuid(), '10.00', opts)));
    dead += res.filter((r) => /deadlock/.test(r.error ?? '')).length; procs += res.filter((r) => r.status === 'PROCESSED').length;
    const s = await snapshot(w); okState &&= s.rebuilt === s.balance;
  }
  console.log(`  ${label}: deadlocks=${dead}  processadas=${procs}/30 esperadas por rodada(10)  consistente=${okState}`);
}

{ // Wallets distintas em paralelo
  const ws = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
  const res = await Promise.all(ws.map((w) => processBet(w, uuid(), '40.00')));
  const all = await Promise.all(ws.map(snapshot));
  (res.every((r) => r.status === 'PROCESSED') && all.every((s) => s.balance === '60.00' && s.rebuilt === s.balance))
    ? ok('20 wallets distintas em paralelo, todas consistentes') : bad('wallets distintas', JSON.stringify(res.slice(0,3)));
}
{ // CONTROLE NEGATIVO: SEM lock, o banco precisa pegar o lost update no COMMIT
  const w = await openWallet('100.00');
  const res = await Promise.all([processBet(w, uuid(), '80.00', { lock: false }), processBet(w, uuid(), '80.00', { lock: false })]);
  const s = await snapshot(w); const errs = res.filter((r) => r.error);
  (errs.length >= 1 && /lost update|serializ|deadlock|divergente|cadeia/i.test(errs[0].error) && s.debits === 1 && s.rebuilt === s.balance)
    ? ok(`controle negativo (SEM lock): o banco abortou um deles → "${errs[0].error.slice(0, 60)}"; saldo ${s.balance}, ${s.debits} débito`)
    : bad('controle negativo sem lock', JSON.stringify({ res, s }));
}
console.log(`\nResultado: ${pass} passaram, ${fail} falharam`);
await pool.end(); process.exit(fail ? 1 : 0);
