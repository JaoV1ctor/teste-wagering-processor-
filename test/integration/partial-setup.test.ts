// Ambientes descartáveis: uma falha no meio do setup não pode deixar banco, fila, servidor ou
// processo para trás. As falhas são reais (endpoint morto, fila ou tabela em conflito, configuração inválida); nada é simulado.
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import { CreateQueueCommand, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { createProbe } from '../support/db';
import { World } from '../support/random-invariants/world';

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
