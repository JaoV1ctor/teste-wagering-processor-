// OutboxRepository (SPEC D7): persistência do envelope e claim por lease com FOR UPDATE SKIP LOCKED. Postgres REAL.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, parkOutbox } from '../support/db';

const probe = createProbe(4);
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});
beforeEach(() => parkOutbox(probe));

const brl = (v: string) => Money.fromString(v, 'BRL');

/** Mensagem de outbox avulsa (só o envelope importa aqui; a FK não existe: o outbox não referencia outras tabelas). */
function message(occurredAt: Date): OutboxMessage {
  const walletId = uuid();
  const tx = WagerTransaction.create({
    id: uuid(), providerId: 'p', externalTransactionId: `x-${uuid()}`, idempotencyKey: `k-${uuid()}`, payloadHash: 'a'.repeat(64), walletId, playerId: uuid(),
    roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Loss, money: brl('5.00'), now: occurredAt,
  });
  tx.markProcessed({ observedBalance: brl('5.00'), at: occurredAt });
  return OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, { eventId: uuid(), correlationId: 'c', occurredAt }));
}

const add = (...messages: OutboxMessage[]) => uow.run(async ({ outbox }) => { for (const m of messages) await outbox.add(m); });
const claim = (now: Date, limit: number, leaseMs = 30_000) =>
  uow.run(({ outbox }) => outbox.claimDue(now, limit, new Date(now.getTime() + leaseMs)));

describe('OutboxRepository', () => {
  test('add grava o envelope como jsonb com MoneyProps em string; o claim devolve o mesmo estado', async () => {
    const base = new Date(Date.now() - 60_000);
    const original = message(base);
    await add(original);

    const { rows } = await probe.query('select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at from outbox_messages where id = $1', [original.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: original.id, aggregate_id: original.aggregateId, event_type: 'WagerTransactionProcessed', attempts: 0, published_at: null });
    expect(rows[0].payload.data.money).toEqual({ amount: '5.00', currency: 'BRL' });
    expect(rows[0].payload).toEqual(JSON.parse(JSON.stringify(original.payload)));

    const [claimed] = await claim(new Date(), 1000);
    expect(claimed?.id).toBe(original.id);
    expect(claimed?.eventType).toBe('WagerTransactionProcessed');
    expect(claimed?.payload).toEqual(original.payload);
    expect(claimed?.occurredAt).toEqual(base);
    expect(claimed?.attempts).toBe(0);
    expect(claimed?.publishedAt).toBeUndefined();
  });

  test('o mesmo eventId não entra duas vezes (id é a PK)', async () => {
    const m = message(new Date(Date.now() - 60_000));
    await add(m);
    await expect(add(m)).rejects.toThrow();
  });

  test('claims concorrentes recebem lotes DISJUNTOS (FOR UPDATE SKIP LOCKED): cada evento é reivindicado uma única vez', async () => {
    const base = new Date(Date.now() - 60_000);
    const created = Array.from({ length: 24 }, (_, i) => message(new Date(base.getTime() + i)));
    await add(...created);

    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 6 }, () => claim(now, 5)));
    claims.push(await claim(now, 100)); // o que sobrou, se algum claim concorrente pulou linhas travadas

    const ids = claims.flat().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(created.map((m) => m.id)));
  });

  test('o claim IGNORA linhas travadas por outra transação em vez de esperar (SKIP LOCKED) e respeita o limite', async () => {
    const base = new Date(Date.now() - 60_000);
    const [locked, free1, free2] = [message(base), message(new Date(base.getTime() + 1)), message(new Date(base.getTime() + 2))] as [OutboxMessage, OutboxMessage, OutboxMessage];
    await add(locked, free1, free2);

    const holder = await probe.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from outbox_messages where id = $1 for update', [locked.id]); // segura a linha mais antiga
      const started = Date.now();
      const claimed = await claim(new Date(), 100);
      expect(Date.now() - started).toBeLessThan(1500); // sem SKIP LOCKED esperaria o lock_timeout (3 s) e daria erro
      expect(new Set(claimed.map((m) => m.id))).toEqual(new Set([free1.id, free2.id]));
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });

  test('lease: o evento reivindicado some até o lease vencer; depois volta a ser elegível', async () => {
    const base = new Date(Date.now() - 60_000);
    const m = message(base);
    await add(m);
    const now = new Date();
    expect(await claim(now, 10, 30_000)).toHaveLength(1);
    expect(await claim(new Date(now.getTime() + 29_000), 10)).toHaveLength(0); // lease ainda vale
    const again = await claim(new Date(now.getTime() + 31_000), 10); // lease vencido: quem reivindicou morreu
    expect(again.map((x) => x.id)).toEqual([m.id]);
  });

  test('só vem o que está vencido e não publicado; o mais antigo primeiro', async () => {
    const now = new Date();
    const old = message(new Date(now.getTime() - 120_000));
    const recent = message(new Date(now.getTime() - 60_000));
    const future = message(new Date(now.getTime() + 600_000)); // next_attempt_at no futuro
    await add(future, recent, old);
    const claimed = await claim(now, 100);
    expect(claimed.map((m) => m.id)).toEqual([old.id, recent.id]);
  });

  test('markPublished grava published_at e tira o evento do claim para sempre', async () => {
    const m = message(new Date(Date.now() - 60_000));
    await add(m);
    const [claimed] = await claim(new Date(), 10);
    if (!claimed) throw new Error('claim vazio');
    claimed.markPublished(new Date());
    await uow.run(({ outbox }) => outbox.markPublished(claimed));
    const { rows } = await probe.query('select published_at from outbox_messages where id = $1', [m.id]);
    expect(rows[0].published_at).not.toBeNull();
    expect(await claim(new Date(Date.now() + 3_600_000), 10)).toHaveLength(0);
  });

  test('scheduleRetry grava attempts e next_attempt_at; e NÃO atropela um evento que outro publisher já publicou', async () => {
    const m = message(new Date(Date.now() - 60_000));
    await add(m);
    const now = new Date();
    const [slow] = await claim(now, 10);
    if (!slow) throw new Error('claim vazio');
    const [other] = await claim(new Date(now.getTime() + 31_000), 10); // o lease do 1º venceu; o 2º publisher reivindica
    if (!other) throw new Error('claim vazio');
    other.markPublished(new Date());
    await uow.run(({ outbox }) => outbox.markPublished(other));

    slow.scheduleRetry(now, () => 0); // o 1º chega atrasado e falha
    await uow.run(({ outbox }) => outbox.scheduleRetry(slow));
    const { rows } = await probe.query('select attempts, published_at from outbox_messages where id = $1', [m.id]);
    expect(rows[0].attempts).toBe(0); // o retry atrasado não vale: já foi publicado
    expect(rows[0].published_at).not.toBeNull();
  });

  test('scheduleRetry de um evento pendente persiste a nova tentativa', async () => {
    const m = message(new Date(Date.now() - 60_000));
    await add(m);
    const now = new Date();
    const [claimed] = await claim(now, 10);
    if (!claimed) throw new Error('claim vazio');
    claimed.scheduleRetry(now, () => 0);
    await uow.run(({ outbox }) => outbox.scheduleRetry(claimed));
    const { rows } = await probe.query('select attempts, next_attempt_at from outbox_messages where id = $1', [m.id]);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].next_attempt_at.getTime()).toBe(now.getTime() + 1000);
  });
});
