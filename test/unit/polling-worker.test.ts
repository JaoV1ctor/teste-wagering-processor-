// Mecânica do loop periódico (start/stop/erros), isolada do banco com um `runOnce` de mentira: aqui não há Postgres a mockar,
// só o relógio de espera. O comportamento com o banco real está em test/integration/pending-reference-worker.test.ts e outbox-publisher.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { PollingWorker } from '../../src/infrastructure/workers/polling-worker';

const empty = { claimed: 0 };
// Nestes testes o runOnce de mentira não falha: qualquer erro reportado é registrado e derruba o teste no afterEach.
const unexpected: unknown[] = [];
const record = (error: unknown): void => {
  unexpected.push(error);
};
afterEach(() => {
  expect(unexpected.splice(0)).toEqual([]);
});

describe('PollingWorker', () => {
  test('start() executa runOnce repetidamente; start() de novo não cria um segundo loop', async () => {
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const worker = new PollingWorker(
      {
        runOnce: async () => {
          calls += 1;
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await Bun.sleep(5);
          concurrent -= 1;
          return empty;
        },
      },
      { pollIntervalMs: 5, batchSize: 10, onError: record },
    );
    worker.start();
    worker.start();
    expect(worker.isRunning).toBe(true);
    while (calls < 5) await Bun.sleep(5);
    await worker.stop();
    expect(maxConcurrent).toBe(1);
  });

  test('stop() espera a execução em andamento terminar e depois nenhuma nova começa', async () => {
    let started = 0;
    let finished = 0;
    const worker = new PollingWorker(
      { runOnce: async () => { started += 1; await Bun.sleep(80); finished += 1; return empty; } },
      { pollIntervalMs: 5, batchSize: 10, onError: record },
    );
    worker.start();
    while (started === 0) await Bun.sleep(1);
    await worker.stop(); // a execução está no meio
    expect(finished).toBe(started);
    expect(worker.isRunning).toBe(false);

    const settled = started;
    await Bun.sleep(60);
    expect(started).toBe(settled);
  });

  test('stop() sem start() e stop() repetido são inofensivos', async () => {
    const worker = new PollingWorker({ runOnce: async () => empty }, { pollIntervalMs: 5, batchSize: 10, onError: record });
    await worker.stop();
    worker.start();
    await worker.stop();
    await worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  test('erro em runOnce vai para onError (não é engolido) e o loop continua', async () => {
    const boom = new Error('banco fora');
    const reported: unknown[] = [];
    let calls = 0;
    const worker = new PollingWorker(
      { runOnce: async () => { calls += 1; if (calls === 1) throw boom; return empty; } },
      { pollIntervalMs: 5, batchSize: 10, onError: (error) => reported.push(error) },
    );
    worker.start();
    while (calls < 3) await Bun.sleep(5);
    await worker.stop();
    expect(reported).toEqual([boom]);
  });

  test('lote cheio: reexecuta de imediato, sem esperar o intervalo de polling', async () => {
    let calls = 0;
    const worker = new PollingWorker(
      { runOnce: async () => { calls += 1; return { claimed: calls < 4 ? 10 : 0 }; } },
      { pollIntervalMs: 60_000, batchSize: 10, onError: record },
    );
    worker.start();
    const deadline = Date.now() + 2000;
    while (calls < 4 && Date.now() < deadline) await Bun.sleep(5);
    await worker.stop();
    expect(calls).toBe(4);
  });
});
