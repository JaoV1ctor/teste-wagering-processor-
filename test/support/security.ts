// Apoio da suíte de segurança: ambiente isolado (banco e filas próprios, aplicação real), registro de cada caso para o relatório e as
// conferências repetidas: nada mudou no banco, e a resposta não vaza detalhe interno.
import { expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import { requireEnv } from '../../src/infrastructure/env';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { type Api, startApi } from './app';
import { newQueues, type TestQueues } from './sqs';

/** Credencial falsa e única dada à aplicação isolada: se aparecer em resposta ou log, é vazamento. */
export const SECRET_CANARY = 'sec-canary-aws-secret-8f2c1d';

export interface Isolated {
  api: Api;
  databaseUrl: string;
  probe: pg.Pool;
  sqs: SQSClient;
  queues: TestQueues;
  /** Sobe outra aplicação sobre o mesmo banco e filas, com variáveis extras. É encerrada junto. */
  startAnother(env?: Record<string, string>): Promise<Api>;
  close(): Promise<void>;
}

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Banco criado e apagado por este arquivo de teste, filas com prefixo único e a aplicação real apontada para eles. */
export async function startIsolated(env: Record<string, string> = {}): Promise<Isolated> {
  const name = `wager_sec_${uuid().replaceAll('-', '').slice(0, 16)}`;
  await admin(`create database ${name}`);
  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  const orm = await MikroORM.init({ ...createOrmConfig(), clientUrl: databaseUrl, discovery: { warnWhenNoEntities: false }, extensions: [Migrator] });
  try {
    await orm.migrator.up();
  } finally {
    await orm.close();
  }

  const sqs = createSqsClient();
  const queues = await newQueues(sqs);
  const appEnv = {
    DATABASE_URL: databaseUrl, SQS_WAGER_QUEUE_NAME: queues.names.queueName, SQS_WAGER_DLQ_NAME: queues.names.deadLetterQueueName,
    SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName, SQS_WAIT_TIME_SECONDS: '1', AWS_SECRET_ACCESS_KEY: SECRET_CANARY,
  };
  const apps: Api[] = [];
  const startAnother = async (extra: Record<string, string> = {}): Promise<Api> => {
    const app = await startApi({ ...appEnv, ...extra });
    apps.push(app);
    return app;
  };
  const api = await startAnother(env);
  const probe = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  return {
    api, databaseUrl, probe, sqs, queues, startAnother,
    async close() {
      await Promise.all(apps.map((app) => app.close()));
      await probe.end();
      for (const queueUrl of [queues.mainUrl, queues.dlqUrl, queues.eventsUrl]) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      sqs.destroy();
      await admin(`drop database ${name} with (force)`);
    },
  };
}

/** Retrato do que importa no banco: qualquer escrita ou mudança de saldo o altera. */
export async function snapshot(probe: pg.Pool): Promise<Record<string, string>> {
  const { rows } = await probe.query<Record<string, string>>(
    `select (select count(*) from wallets)::text as wallets,
            (select coalesce(string_agg(id::text || ':' || balance::text || ':' || version, ',' order by id), '') from wallets) as balances,
            (select count(*) from wager_transactions)::text as transactions,
            (select count(*) from wallet_ledger_entries)::text as ledger,
            (select count(*) from inbox_messages)::text as inbox,
            (select count(*) from outbox_messages)::text as outbox`,
  );
  return rows[0]!;
}

/** Marcas de detalhe interno que não podem aparecer em resposta nenhuma. */
const LEAKS: [string, RegExp][] = [
  ['stack trace', /\n\s+at |\bat [\w.<>]+ \(|node_modules|"stack"/i],
  ['SQL', /\bselect\b[\s\S]{0,200}\bfrom\b|\binsert into\b|\bupdate\s+"?\w+"?\s+set\b/i],
  ['erro do banco ou do driver', /relation "|column "|violates|SQLSTATE|syntax error|invalid byte sequence|invalid input syntax|DriverException|MikroORM|\bpg_|duplicate key/i],
  ['string de conexão ou credencial', /postgres(ql)?:\/\/|:wager@|sec-canary/i],
  ['caminho do servidor', /[A-Z]:\\|\/src\/(application|domain|infrastructure|interface)\//],
];

export function leaksIn(text: string): string[] {
  return LEAKS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
}

export async function send(api: Api, method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${api.url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

export const postJson = (api: Api, path: string, payload: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  send(api, 'POST', path, typeof payload === 'string' ? payload : JSON.stringify(payload), { 'content-type': 'application/json', ...headers });

/** Bytes crus em um socket: o que o `fetch` recusaria enviar (CR ou LF soltos em cabeçalho, método inventado). */
export function sendRawHttp(api: Api, request: string): Promise<string> {
  const { port } = new URL(api.url);
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect({ host: '127.0.0.1', port: parseInt(port, 10) }, () => socket.write(request));
    socket.setTimeout(10_000, () => socket.destroy(new Error('sem resposta em 10 s')));
    socket.on('data', (chunk) => { received += chunk.toString('latin1'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
  });
}

/** `400×12, 404×1` a partir de uma lista de status. */
export function tally(statuses: readonly (number | string)[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(String(status), (counts.get(String(status)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([status, n]) => `${status}×${n}`).join(', ');
}

/** Rótulo, ataque e, quando a validação pode repetir a entrada na resposta, o valor enviado (que não conta como vazamento). */
export type Attempt = readonly [label: string, attempt: () => Promise<Reply>, sent?: string];

/**
 * Cada tentativa deve ser recusada com um dos status esperados, sem vazar detalhe interno e sem mudar o banco. Roda TODAS antes de
 * afirmar, para o relatório mostrar quantas e quais falharam. Devolve o resumo dos status.
 */
export async function expectRejected(probe: pg.Pool, attempts: readonly Attempt[], allowed: readonly number[] = [400]): Promise<string> {
  const before = await snapshot(probe);
  const statuses: number[] = [];
  const problems: string[] = [];
  for (const [label, attempt, sent] of attempts) {
    const reply = await attempt();
    statuses.push(reply.status);
    if (!allowed.includes(reply.status)) problems.push(`${label}: HTTP ${reply.status}`);
    const text = sent === undefined ? reply.text : reply.text.replaceAll(JSON.stringify(sent).slice(1, -1), '');
    for (const leak of leaksIn(text)) problems.push(`${label}: vazou ${leak}`);
  }
  expect(problems).toEqual([]);
  expect(await snapshot(probe)).toEqual(before);
  return `${attempts.length} tentativas: ${tally(statuses)}; banco inalterado`;
}

export type CaseKind = 'controle' | 'limitação';

interface Row {
  name: string;
  expected: string;
  observed: string;
  result: 'passou' | 'limitação confirmada' | 'FALHOU';
}

const cell = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replaceAll('|', '\\|').slice(0, 300);

/** Registra os casos de uma categoria; `write()` (no `afterAll`) grava o que de fato aconteceu para o relatório. */
export function securityCategory(number: number, title: string) {
  const rows: Row[] = [];
  /**
   * `run` faz o ataque, afirma o resultado esperado e devolve o que observou. Um caso de `limitação` afirma o comportamento ATUAL, que é
   * mais fraco que o desejável: passar significa que a limitação continua lá.
   */
  const securityCase = (name: string, expected: string, run: () => Promise<string>, kind: CaseKind = 'controle') => {
    test(name, async () => {
      try {
        const observed = await run();
        rows.push({ name, expected, observed, result: kind === 'controle' ? 'passou' : 'limitação confirmada' });
      } catch (error) {
        rows.push({ name, expected, observed: error instanceof Error ? error.message : String(error), result: 'FALHOU' });
        throw error;
      }
    }, 60_000);
  };
  const write = () => {
    mkdirSync('security-results', { recursive: true });
    const cleaned = rows.map((row) => ({ ...row, name: cell(row.name), expected: cell(row.expected), observed: cell(row.observed) }));
    writeFileSync(`security-results/${String(number).padStart(2, '0')}.json`, JSON.stringify({ number, title, rows: cleaned }, null, 2));
  };
  return { securityCase, write };
}
