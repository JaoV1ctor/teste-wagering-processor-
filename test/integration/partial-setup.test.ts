// Ambientes descartáveis (segurança, invariantes aleatórias e carga): uma falha no meio do setup não pode deixar banco, fila, servidor ou
// processo para trás. As falhas são reais (endpoint morto, fila ou tabela em conflito, configuração inválida); nada é simulado.
import { randomUUID as uuid } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { CreateQueueCommand, ListQueuesCommand } from '@aws-sdk/client-sqs';
import pg from 'pg';
import { createDatabase, startInstances, withIsolatedStack } from '../../scripts/load/stack';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { createProbe } from '../support/db';
import { World } from '../support/random-invariants/world';
import { startIsolated } from '../support/security';

const sqs = createSqsClient();
const probe = createProbe();
afterAll(async () => {
  sqs.destroy();
  await probe.end();
});

const newId = (): string => uuid().replaceAll('-', '').slice(0, 16);

async function databasesLike(pattern: string): Promise<string[]> {
  const { rows } = await probe.query<{ datname: string }>('select datname from pg_database where datname like $1 order by 1', [pattern]);
  return rows.map((row) => row.datname);
}

async function queuesWith(prefix: string): Promise<string[]> {
  const { QueueUrls = [] } = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
  return QueueUrls;
}

/** Ocupa o nome da ÚLTIMA fila a ser criada com atributo diferente: as duas primeiras sobem e a terceira falha. */
async function occupyEventsQueue(prefix: string): Promise<void> {
  await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}wager-events`, Attributes: { VisibilityTimeout: '31' } }));
}

/** Aponta o SQS para uma porta sem ninguém escutando, só durante `work`. */
async function withDeadSqs<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env['AWS_ENDPOINT_URL'];
  process.env['AWS_ENDPOINT_URL'] = 'http://127.0.0.1:9';
  try {
    return await work();
  } finally {
    process.env['AWS_ENDPOINT_URL'] = previous;
  }
}

const answers = (url: string): Promise<boolean> => fetch(`${url}/health/live`).then(() => true, () => false);

describe('ambiente da suíte de segurança', () => {
  test('banco sobe e o SQS não responde: o banco é apagado', async () => {
    const id = newId();
    await expect(withDeadSqs(() => startIsolated({}, { id }))).rejects.toThrow();
    expect(await databasesLike(`wager_sec_${id}`)).toEqual([]);
  }, 60_000);

  test('a terceira fila falha: o banco e as duas filas já criadas são apagados', async () => {
    const id = newId();
    await occupyEventsQueue(`sec-${id}-`);
    await expect(startIsolated({}, { id })).rejects.toThrow();
    expect(await queuesWith(`sec-${id}-`)).toEqual([]);
    expect(await databasesLike(`wager_sec_${id}`)).toEqual([]);
  }, 60_000);

  test('a aplicação não sobe: banco e filas são apagados', async () => {
    const id = newId();
    await expect(startIsolated({ SQS_WAIT_TIME_SECONDS: 'invalido' }, { id })).rejects.toThrow('SQS_WAIT_TIME_SECONDS');
    expect(await queuesWith(`sec-${id}-`)).toEqual([]);
    expect(await databasesLike(`wager_sec_${id}`)).toEqual([]);
  }, 60_000);

  test('falha com o servidor já no ar: servidor, conexões, filas e banco são liberados', async () => {
    const id = newId();
    let url = '';
    const setup = startIsolated({}, {
      id,
      afterStart: async (env) => {
        url = env.api.url;
        expect(await answers(url)).toBe(true);
        await env.probe.query('select 1');
        throw new Error('falha forçada depois do servidor');
      },
    });
    await expect(setup).rejects.toThrow('falha forçada depois do servidor');
    expect(await answers(url)).toBe(false);
    expect(await queuesWith(`sec-${id}-`)).toEqual([]);
    expect(await databasesLike(`wager_sec_${id}`)).toEqual([]);
  }, 60_000);
});

describe('ambiente das invariantes aleatórias', () => {
  test('close() remove as filas e o banco criados', async () => {
    const queuePrefix = `world-${newId()}-`;
    const before = await databasesLike('wager_tmp_%');
    const world = await World.create(1, { queuePrefix });
    expect(await queuesWith(queuePrefix)).toHaveLength(3);
    await world.close();
    expect(await queuesWith(queuePrefix)).toEqual([]);
    expect(await databasesLike('wager_tmp_%')).toEqual(before);
  }, 60_000);

  test('a terceira fila falha: nada sobra', async () => {
    const queuePrefix = `world-${newId()}-`;
    const before = await databasesLike('wager_tmp_%');
    await occupyEventsQueue(queuePrefix);
    await expect(World.create(1, { queuePrefix })).rejects.toThrow();
    expect(await queuesWith(queuePrefix)).toEqual([]);
    expect(await databasesLike('wager_tmp_%')).toEqual(before);
  }, 60_000);
});

describe('ambiente do teste de carga', () => {
  const errorLog = join(tmpdir(), `partial-setup-${newId()}.log`);
  const options = (runId: string) => ({ client: sqs, runId, instances: 1, errorLog });

  test('a migration falha: o banco recém-criado é apagado', async () => {
    const suffix = newId();
    const occupyTable = async (url: string): Promise<void> => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query('create table wallets (id int)');
      } finally {
        await client.end();
      }
    };
    await expect(createDatabase(suffix, occupyTable)).rejects.toThrow('wallets');
    expect(await databasesLike(`wager_load_${suffix}`)).toEqual([]);
  }, 60_000);

  test('a terceira fila falha: banco e filas são apagados, e o cenário nem começa', async () => {
    const runId = newId();
    await occupyEventsQueue(`load-${runId}-A-`);
    let started = false;
    await expect(withIsolatedStack(options(runId), 'A', async () => (started = true))).rejects.toThrow();
    expect(started).toBe(false);
    expect(await queuesWith(`load-${runId}-`)).toEqual([]);
    expect(await databasesLike(`wager_load_${runId}%`)).toEqual([]);
  }, 60_000);

  test('a instância não sobe e o encerramento também falha: os dois erros chegam, o da inicialização primeiro', async () => {
    const queue = { name: 'sem-uso', url: 'sem-uso' };
    // Um diretório como arquivo de log: a gravação do stderr é recusada pelo sistema, e `stop()` falha.
    const options = { count: 1, databaseUrl: 'invalida', input: queue, deadLetter: queue, events: queue, errorLog: tmpdir() };
    const previous = process.env['SQS_WAIT_TIME_SECONDS'];
    process.env['SQS_WAIT_TIME_SECONDS'] = 'invalido';
    try {
      const failure = await startInstances(options).then(() => undefined, (error: unknown) => error);
      expect(String(failure)).toContain('instância encerrou ao subir');
      expect(failure).toBeInstanceOf(AggregateError);
      const [startup, cleanup] = (failure as AggregateError).errors;
      expect(String(startup)).toContain('instância encerrou ao subir');
      expect(String(cleanup)).toMatch(/EISDIR|EPERM|EACCES/);
    } finally {
      if (previous === undefined) delete process.env['SQS_WAIT_TIME_SECONDS'];
      else process.env['SQS_WAIT_TIME_SECONDS'] = previous;
    }
  }, 60_000);

  test('o cenário falha com instância no ar e fila extra: processo encerrado, filas e banco apagados', async () => {
    const runId = newId();
    let url = '';
    const scenario = withIsolatedStack(options(runId), 'C', async (stack) => {
      await stack.createQueues('extra');
      url = (await stack.start()).urls[0]!;
      expect(await answers(url)).toBe(true);
      throw new Error('falha forçada no cenário');
    });
    await expect(scenario).rejects.toThrow('falha forçada no cenário');
    expect(await answers(url)).toBe(false);
    expect(await queuesWith(`load-${runId}-`)).toEqual([]);
    expect(await databasesLike(`wager_load_${runId}%`)).toEqual([]);
  }, 120_000);
});
