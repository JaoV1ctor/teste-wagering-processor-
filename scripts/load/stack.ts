/**
 * Ambiente isolado de um cenário: banco próprio (criado e apagado pela execução), filas próprias e instâncias reais da aplicação
 * (`bun run src/main.ts`, com HTTP, consumidor, worker e publisher). Nada do banco ou das filas de desenvolvimento é tocado.
 */
import { appendFileSync } from 'node:fs';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import { requireEnv } from '../../src/infrastructure/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createQueues } from '../create-queues';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DATABASE_PREFIX = 'wager_load_';

/** O experimento cria e apaga bancos e inunda as filas: só contra infraestrutura local. */
export function assertLocalInfrastructure(): void {
  for (const name of ['DATABASE_URL', 'AWS_ENDPOINT_URL']) {
    const host = new URL(requireEnv(name)).hostname;
    if (!LOCAL_HOSTS.has(host)) throw new Error(`${name} aponta para "${host}": o teste de carga só roda contra infraestrutura local`);
  }
}

export interface LoadDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
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

export async function createDatabase(suffix: string): Promise<LoadDatabase> {
  // O nome é montado aqui, com prefixo fixo: só um banco criado por esta execução pode ser apagado por ela.
  const name = `${DATABASE_PREFIX}${suffix}`.toLowerCase();
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`nome de banco inválido: ${name}`);
  await admin(`create database ${name}`);
  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = `/${name}`;
  const orm = await MikroORM.init({ ...createOrmConfig(), clientUrl: url.toString(), discovery: { warnWhenNoEntities: false }, extensions: [Migrator] });
  try {
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return {
    name,
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      await admin(`drop database ${name} with (force)`);
    },
  };
}

export interface LoadQueues {
  input: { name: string; url: string };
  deadLetter: { name: string; url: string };
  events: { name: string; url: string };
}

export async function createLoadQueues(client: SQSClient, prefix: string): Promise<LoadQueues> {
  const created = await createQueues(client, prefix);
  const queue = (base: string) => ({ name: `${prefix}${base}`, url: created[base]!.url });
  return { input: queue('wager-transactions.fifo'), deadLetter: queue('wager-transactions-dlq.fifo'), events: queue('wager-events') };
}

export async function deleteQueues(client: SQSClient, queues: readonly LoadQueues[]): Promise<void> {
  const urls = new Set(queues.flatMap((q) => [q.input.url, q.deadLetter.url, q.events.url]));
  for (const url of urls) await client.send(new DeleteQueueCommand({ QueueUrl: url }));
}

export interface Instances {
  urls: string[];
  stop(): Promise<void>;
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error('não foi possível reservar uma porta');
  return port;
}

export interface InstanceOptions {
  count: number;
  databaseUrl: string;
  input: LoadQueues['input'];
  deadLetter: LoadQueues['deadLetter'];
  events: LoadQueues['events'];
  /** Recebe o stderr das instâncias (os logs `error`). O stdout (um log por transação) é descartado. */
  errorLog: string;
}

/** Sobe as instâncias e espera o readiness de todas. A configuração é a padrão da aplicação, salvo banco, filas e porta. */
export async function startInstances({ count, databaseUrl, input, deadLetter, events, errorLog }: InstanceOptions): Promise<Instances> {
  const started = Array.from({ length: count }, () => {
    const port = freePort();
    const child = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
      env: {
        ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, SQS_WAGER_QUEUE_NAME: input.name, SQS_WAGER_DLQ_NAME: deadLetter.name,
        SQS_EVENTS_QUEUE_NAME: events.name,
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const drained = (async () => {
      for await (const chunk of child.stderr) appendFileSync(errorLog, chunk);
    })();
    return { child, url: `http://127.0.0.1:${port}`, drained };
  });
  const stop = async (): Promise<void> => {
    for (const { child } of started) child.kill();
    await Promise.all(started.map(async ({ child, drained }) => { await child.exited; await drained; }));
  };

  try {
    await Promise.all(started.map(async ({ child, url }) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`instância encerrou ao subir (código ${child.exitCode}); veja ${errorLog}`);
        const ready = await fetch(`${url}/health/ready`).then((response) => response.ok, () => false);
        if (ready) return;
        if (Date.now() > deadline) throw new Error(`instância não ficou pronta em 60 s; veja ${errorLog}`);
        await Bun.sleep(100);
      }
    }));
  } catch (error) {
    await stop();
    throw error;
  }
  return { urls: started.map(({ url }) => url), stop };
}
