// A espera de `bun run infra:queues` pelo MiniStack, com cliente e relógio falsos. Os erros imitam os observados com os containers reais.
import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createQueuesWhenReady, QueueServiceUnavailableError } from '../../scripts/create-queues';

/** No Bun, a conexão recusada em `localhost` chega sem mensagem, só com o código. */
const refused = () => Object.assign(new Error(''), { code: 'ECONNREFUSED' });
const hangUp = () => Object.assign(new Error('socket hang up'), { name: 'TimeoutError', code: 'ECONNRESET' });
const aborted = () => Object.assign(new Error('Request aborted'), { name: 'AbortError' });
const unavailable = () => Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
const http503 = () => Object.assign(new Error('UnknownError'), { $metadata: { httpStatusCode: 503 } });

/** Cliente que falha nas primeiras `failures` chamadas e depois responde como o SQS. */
function flakyClient(failures: number, error: () => Error) {
  const state = { calls: 0, signals: [] as unknown[] };
  const client = {
    send: async (_command: unknown, options?: { abortSignal?: unknown }) => {
      state.calls += 1;
      state.signals.push(options?.abortSignal);
      if (state.calls <= failures) throw error();
      return { QueueUrl: 'http://fila', Attributes: { QueueArn: 'arn:fila' } };
    },
  } as unknown as SQSClient;
  return { client, state };
}

/** Relógio que só anda quando se dorme: 30 s de espera passam sem esperar. */
function fakeClock() {
  const sleeps: number[] = [];
  let time = 0;
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe('createQueuesWhenReady', () => {
  test.each([
    ['conexão recusada', refused], ['conexão encerrada sem resposta', hangUp], ['tentativa sem resposta', aborted],
    ['ServiceUnavailable', unavailable], ['HTTP 503', http503],
  ])('%s: repete a cada 500 ms até o serviço responder', async (_label, error) => {
    const { client, state } = flakyClient(3, error);
    const clock = fakeClock();
    const queues = await createQueuesWhenReady(client, clock);
    expect(Object.keys(queues)).toHaveLength(3);
    expect(clock.sleeps).toEqual([500, 500, 500]);
    expect(state.calls).toBe(3 + 6); // 3 falhas, depois CreateQueue e GetQueueAttributes das três filas
    expect(state.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  test('serviço no ar: nenhuma espera', async () => {
    const { client } = flakyClient(0, refused);
    const clock = fakeClock();
    await createQueuesWhenReady(client, clock);
    expect(clock.sleeps).toEqual([]);
  });

  test.each([
    ['atributo recusado', () => Object.assign(new Error('Invalid attribute'), { name: 'InvalidAttributeValue', $metadata: { httpStatusCode: 400 } })],
    ['credencial recusada', () => Object.assign(new Error('Access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })],
    ['erro interno', () => Object.assign(new Error('boom'), { name: 'InternalFailure', $metadata: { httpStatusCode: 500 } })],
    ['erro sem código', () => new Error('inesperado')],
  ])('%s: falha na primeira tentativa, com o erro original', async (_label, error) => {
    const original = error();
    const { client, state } = flakyClient(Infinity, () => original);
    const clock = fakeClock();
    await expect(createQueuesWhenReady(client, clock)).rejects.toBe(original);
    expect(state.calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test('30 s sem resposta: desiste com mensagem que cita o MiniStack e guarda a causa', async () => {
    const { client, state } = flakyClient(Infinity, refused);
    const clock = fakeClock();
    const failure: unknown = await createQueuesWhenReady(client, clock).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueueServiceUnavailableError);
    expect((failure as Error).message).toContain('O MiniStack não respondeu em 30 s');
    expect((failure as Error).message).toContain('ECONNREFUSED');
    expect((failure as Error).cause).toMatchObject({ code: 'ECONNREFUSED' });
    expect(clock.now()).toBe(29_500); // a próxima tentativa cairia no fim do prazo
    expect(state.calls).toBe(60); // uma no início e uma a cada 500 ms
  });
});
