import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import { Money } from '../../src/domain/money';
import { requireEnv } from '../../src/infrastructure/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';

/** ORM real (Postgres do compose) com o Migrator registrado. Nunca mock. */
export async function initOrm() {
  return MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
}

export type Orm = Awaited<ReturnType<typeof initOrm>>;

/** Garante o schema aplicado (idempotente). */
export async function ensureSchema(): Promise<void> {
  const orm = await initOrm();
  try {
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}

/** Conexão `pg` direta, independente do ORM, para inspecionar o que foi de fato gravado. */
export function createProbe(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max });
}

/** Tabelas de negócio existentes (exclui a de controle do migrator). */
export async function businessTables(orm: Orm): Promise<string[]> {
  const rows = await orm.em.getConnection().execute<{ table_name: string }[]>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
  );
  return rows.map((r) => r.table_name);
}

/**
 * Estende o ledger de uma wallet com `count` créditos de 1.00, direto em SQL e respeitando o schema
 * (wallet travada primeiro; cada lançamento tem sua transação PROCESSED; saldo e version no mesmo commit).
 */
export async function seedCredits(probe: pg.Pool, walletId: string, count: number): Promise<void> {
  const client = await probe.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ player_id: string; balance: string; currency: string }>(
      'select player_id, balance, currency from wallets where id = $1 for no key update', [walletId],
    );
    const wallet = rows[0];
    if (!wallet) throw new Error(`wallet ${walletId} não existe`);
    const one = Money.fromString('1', wallet.currency);
    let balance = Money.fromString(wallet.balance, wallet.currency);
    for (let i = 0; i < count; i += 1) {
      const txId = uuid();
      const before = balance;
      balance = balance.add(one);
      await client.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, observed_balance, processed_at)
         values ($1,'seed',$2,$2,$3,$4,$5,'r','g','WIN','1.00',$6,'PROCESSED',$7,now())`,
        [txId, `seed:${txId}`, 'a'.repeat(64), walletId, wallet.player_id, wallet.currency, balance.toString()],
      );
      await client.query(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values ($1,$2,$3,'CREDIT','1.00',$4,$5,$6)`,
        [uuid(), walletId, txId, wallet.currency, before.toString(), balance.toString()],
      );
    }
    await client.query('update wallets set balance = $2, version = version + 1 where id = $1', [walletId, balance.toString()]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Invariante final (SPEC §10): saldo da wallet == saldo reconstruído pelo ledger. */
export async function ledgerBalance(probe: pg.Pool, walletId: string): Promise<{ stored: string; rebuilt: string; entries: number }> {
  const { rows } = await probe.query<{ stored: string; rebuilt: string; entries: string }>(
    `select w.balance::text as stored,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as rebuilt,
            count(l.id)::text as entries
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = $1 group by w.id`,
    [walletId],
  );
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} não existe`);
  return { stored: row.stored, rebuilt: row.rebuilt, entries: Number.parseInt(row.entries, 10) };
}

/** Isola o teste: eventos que outros testes deixaram sem publicar saem da fila do outbox (`published_at` preenchido) e nenhum publisher os reivindica. */
export async function parkOutbox(probe: pg.Pool): Promise<void> {
  await probe.query('update outbox_messages set published_at = now() where published_at is null');
}

/**
 * Isola o teste: transações PENDING_REFERENCE de outros testes (que ninguém resolve) passam a vencer no "infinito" e deixam de ser
 * reivindicadas. O trigger permite mudar só `next_attempt_at` de uma transação não terminal.
 */
export async function parkPendingReferences(probe: pg.Pool): Promise<void> {
  await probe.query("update wager_transactions set next_attempt_at = 'infinity' where status = 'PENDING_REFERENCE'");
}
