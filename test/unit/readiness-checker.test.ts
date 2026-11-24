import { describe, expect, test } from 'bun:test';
import { type DependencyCheck, ReadinessChecker } from '../../src/infrastructure/health/readiness';

const up = (name: string): DependencyCheck => ({ name, check: async () => undefined });
const failing = (name: string, error = new Error('boom')): DependencyCheck => ({ name, check: async () => { throw error; } });
/** Nunca resolve e ignora o sinal: o timeout do checker é que precisa devolver a resposta. */
const hanging = (name: string): DependencyCheck => ({ name, check: () => new Promise<void>(() => undefined) });

const checker = (checks: DependencyCheck[], onFailure: (name: string, error: unknown) => void = () => undefined) =>
  new ReadinessChecker(checks, { timeoutMs: 50, onFailure });

describe('ReadinessChecker', () => {
  test('todas as dependências ok: ready', async () => {
    expect(await checker([up('postgres'), up('sqs')]).run()).toEqual({ ready: true, checks: { postgres: 'up', sqs: 'up' } });
  });

  test('uma que falha derruba o conjunto e aponta qual; a causa vai ao onFailure, não ao resultado', async () => {
    const failures: [string, unknown][] = [];
    const error = new Error('detalhe interno');
    const result = await checker([up('postgres'), failing('sqs', error)], (name, cause) => failures.push([name, cause])).run();
    expect(result).toEqual({ ready: false, checks: { postgres: 'up', sqs: 'down' } });
    expect(failures).toEqual([['sqs', error]]);
    expect(JSON.stringify(result)).not.toContain('detalhe interno');
  });

  test('uma que não responde vira down no timeout, mesmo ignorando o sinal de cancelamento', async () => {
    const started = Date.now();
    const result = await checker([up('postgres'), hanging('sqs')]).run();
    expect(result).toEqual({ ready: false, checks: { postgres: 'up', sqs: 'down' } });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('as verificações rodam em paralelo: o tempo total é o do timeout, não a soma', async () => {
    const started = Date.now();
    await checker([hanging('a'), hanging('b'), hanging('c')]).run();
    expect(Date.now() - started).toBeLessThan(150);
  });

  test('o sinal entregue à verificação é cancelado no timeout', async () => {
    let aborted = false;
    const watching: DependencyCheck = {
      name: 'sqs',
      check: (signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); })),
    };
    await checker([watching]).run();
    expect(aborted).toBe(true);
  });
});
