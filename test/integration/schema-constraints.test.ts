// Constraints e triggers que `schema.test.ts` não exercita: unicidade, imutabilidade e não-negatividade impostas pelo banco.
// Postgres REAL, SQL cru. Cada caso exige o NOME da constraint (ou a mensagem do trigger): outra barreira recusar a linha não basta.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import type pg from 'pg';
import { createProbe, ensureSchema } from '../support/db';

const pool = createProbe(2);
beforeAll(() => ensureSchema());
afterAll(() => pool.end());

/** Roda em uma transação que sempre é desfeita: nada fica no banco compartilhado. */
async function inRollback(work: (c: pg.PoolClient) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
const rejects = (constraint: RegExp, work: (c: pg.PoolClient) => Promise<unknown>) => expect(inRollback(work)).rejects.toThrow(constraint);

async function insert(c: pg.PoolClient, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await c.query(`insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}

interface Wallet { id: string; player: string }
async function wallet(c: pg.PoolClient, overrides: Record<string, unknown> = {}): Promise<Wallet> {
  const created = { id: uuid(), player: uuid() };
  await insert(c, 'wallets', { id: created.id, player_id: created.player, currency: 'BRL', balance: '0.00', ...overrides });
  return created;
}

/** Transação válida em PENDING; `overrides` introduz a violação que o caso quer. */
async function transaction(c: pg.PoolClient, owner: Wallet, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = (overrides['id'] as string | undefined) ?? uuid();
  await insert(c, 'wager_transactions', {
    id, provider_id: 'p', external_transaction_id: id, idempotency_key: id, payload_hash: 'a'.repeat(64), wallet_id: owner.id,
    player_id: owner.player, round_id: 'r', game_id: 'g', kind: 'BET', amount: '10.00', currency: 'BRL', status: 'PENDING', ...overrides,
  });
  return id;
}

const entry = (c: pg.PoolClient, owner: Wallet, transactionId: string, overrides: Record<string, unknown> = {}) =>
  insert(c, 'wallet_ledger_entries', {
    id: uuid(), wallet_id: owner.id, transaction_id: transactionId, direction: 'CREDIT', amount: '100.00', currency: 'BRL',
    balance_before: '0.00', balance_after: '100.00', ...overrides,
  });

/** Wallet com 100.00 já justificados pelo ledger, dentro da transação do caso. */
async function fundedWallet(c: pg.PoolClient): Promise<Wallet> {
  const owner = await wallet(c, { balance: '100.00' });
  await entry(c, owner, await transaction(c, owner, { kind: 'OPENING', amount: '100.00' }));
  return owner;
}

describe('wallets', () => {
  test('version começa em 1: zero é recusado', async () => {
    await rejects(/wallets_version_check/, (c) => wallet(c, { version: 0 }));
  });

  test.each([['id', uuid()], ['player_id', uuid()], ['currency', 'USD']])('%s é imutável', async (column, value) => {
    await rejects(/id, player_id e currency são imutáveis/, async (c) => {
      const owner = await wallet(c);
      await c.query(`update wallets set ${column} = $2 where id = $1`, [owner.id, value]);
    });
  });
});

describe('wager_transactions', () => {
  test.each<[string, RegExp, Record<string, unknown>]>([
    ['valor zero', /wager_transactions_amount_check/, { amount: '0.00' }],
    ['valor negativo', /wager_transactions_amount_check/, { amount: '-1.00' }],
    ['moeda fora do formato', /wager_transactions_currency_check/, { currency: 'brl' }],
    ['tipo desconhecido', /wager_transactions_kind_check/, { kind: 'JACKPOT' }],
    ['estado desconhecido', /wager_transactions_status_check/, { status: 'DONE' }],
    ['saldo observado negativo', /wager_transactions_observed_balance_check/, { observed_balance: '-0.01' }],
    ['tentativas negativas', /wager_transactions_attempts_check/, { attempts: -1 }],
    ['BET com referência', /wt_reference_by_kind/, { reference_external_transaction_id: 'x' }],
    ['OPENING com referência', /wt_reference_by_kind/, { kind: 'OPENING', reference_external_transaction_id: 'x' }],
    ['ROLLBACK sem referência', /wt_reference_by_kind/, { kind: 'ROLLBACK' }],
    ['failure_code fora de REJECTED/FAILED', /wt_failure_code_iff_failed/, { failure_code: 'X' }],
    ['FAILED sem failure_code', /wt_failure_code_iff_failed/, { status: 'FAILED' }],
    ['PROCESSED sem saldo observado', /wt_processed_fields/, { status: 'PROCESSED', processed_at: new Date() }],
    ['PROCESSED sem processed_at', /wt_processed_fields/, { status: 'PROCESSED', observed_balance: '0.00' }],
    ['processed_at fora de PROCESSED', /wt_processed_at_only_processed/, { processed_at: new Date() }],
    ['reversão PROCESSED sem a transação revertida', /wt_reversal_has_reference/,
      { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PROCESSED', processed_at: new Date(), observed_balance: '0.00' }],
  ])('recusa %s', async (_name, constraint, overrides) => {
    await rejects(constraint, async (c) => transaction(c, await wallet(c), overrides));
  });

  test('recusa referência a si mesma', async () => {
    const id = uuid();
    await rejects(/wt_not_self_reference/, async (c) =>
      transaction(c, await wallet(c), { id, kind: 'WIN', reference_external_transaction_id: 'x', reference_transaction_id: id }));
  });

  test('recusa wallet inexistente', async () => {
    await rejects(/wager_transactions_wallet_id_fkey/, (c) => transaction(c, { id: uuid(), player: uuid() }));
  });

  test.each([
    ['amount', '11.00'], ['idempotency_key', 'outra'], ['external_transaction_id', 'outro'], ['payload_hash', 'b'.repeat(64)], ['kind', 'LOSS'], ['round_id', 'outra'],
  ])('coluna de identidade %s é imutável, mesmo em transação não terminal', async (column, value) => {
    await rejects(/colunas de identidade são imutáveis/, async (c) => {
      const id = await transaction(c, await wallet(c));
      await c.query(`update wager_transactions set ${column} = $2 where id = $1`, [id, value]);
    });
  });
});

describe('wallet_ledger_entries', () => {
  const second = async (c: pg.PoolClient, overrides: Record<string, unknown>) => {
    const owner = await fundedWallet(c);
    await entry(c, owner, await transaction(c, owner), { direction: 'DEBIT', amount: '10.00', balance_before: '100.00', balance_after: '90.00', ...overrides });
  };

  test('recusa valor negativo, mesmo com a aritmética fechando', async () => {
    await rejects(/wallet_ledger_entries_amount_check/, (c) => second(c, { direction: 'CREDIT', amount: '-10.00' }));
  });

  test('recusa lançamento que deixaria o saldo negativo, mesmo com a aritmética fechando', async () => {
    await rejects(/wallet_ledger_entries_balance_after_check/, (c) => second(c, { amount: '200.00', balance_after: '-100.00' }));
  });

  test('recusa direção desconhecida', async () => {
    await rejects(/le_balanced|wallet_ledger_entries_direction_check/, (c) => second(c, { direction: 'TRANSFER' }));
  });

  test('recusa lançamento sem transação', async () => {
    await rejects(/wallet_ledger_entries_transaction_id_fkey/, async (c) => entry(c, await wallet(c, { balance: '100.00' }), uuid()));
  });
});

describe('inbox e outbox', () => {
  const message = (c: pg.PoolClient, consumer: string, id: string) =>
    insert(c, 'inbox_messages', { consumer_name: consumer, message_id: id, payload_hash: 'a'.repeat(64) });

  test('inbox: a mesma messageId não entra duas vezes no mesmo consumidor', async () => {
    const id = uuid();
    await rejects(/inbox_messages_pkey/, async (c) => {
      await message(c, 'consumidor-a', id);
      await message(c, 'consumidor-a', id);
    });
  });

  test('inbox: a deduplicação é por consumidor; outro consumidor registra a mesma messageId', async () => {
    const id = uuid();
    await inRollback(async (c) => {
      await message(c, 'consumidor-a', id);
      await message(c, 'consumidor-b', id);
      expect((await c.query('select 1 from inbox_messages where message_id = $1', [id])).rowCount).toBe(2);
    });
  });

  test('outbox: tentativas negativas são recusadas', async () => {
    await rejects(/outbox_messages_attempts_check/, (c) =>
      insert(c, 'outbox_messages', { id: uuid(), aggregate_id: uuid(), event_type: 'X', payload: '{}', occurred_at: new Date(), attempts: -1 }));
  });
});
