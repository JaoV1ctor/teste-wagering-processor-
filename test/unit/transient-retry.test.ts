import { describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import { isTransient, withTransientRetry } from '../../src/infrastructure/persistence/transient-retry';

const fast = { attempts: 3, baseDelayMs: 0 };
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('isTransient', () => {
  test.each(['40P01', '40001', '57P01', '08006', 'ECONNREFUSED', 'ECONNRESET'])('%s é transitório', (code) => {
    expect(isTransient(pgError(code))).toBe(true);
  });

  test.each(['23505', '23514', '22003', '42P01'])('%s é permanente', (code) => {
    expect(isTransient(pgError(code))).toBe(false);
  });

  test('erros sem código e valores não-Error são permanentes', () => {
    expect(isTransient(new Error('bug'))).toBe(false);
    expect(isTransient('x')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe('withTransientRetry', () => {
  test('sucesso na primeira tentativa: executa uma vez', async () => {
    let calls = 0;
    const result = await withTransientRetry(async () => { calls += 1; return 'ok'; }, fast);
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('deadlock (40P01) e serialização (40001) são reexecutados até dar certo', async () => {
    const failures = [pgError('40P01'), pgError('40001')];
    let calls = 0;
    const result = await withTransientRetry(async () => {
      calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return 'ok';
    }, fast);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('esgotadas as tentativas: TransientInfrastructureError com a causa original', async () => {
    let calls = 0;
    const cause = pgError('40P01');
    const error = await withTransientRetry(async () => { calls += 1; throw cause; }, fast).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).cause).toBe(cause);
    expect(calls).toBe(3);
  });

  test('erro permanente não é reexecutado e chega intacto', async () => {
    let calls = 0;
    const cause = pgError('23505');
    const error = await withTransientRetry(async () => { calls += 1; throw cause; }, fast).catch((e: unknown) => e);
    expect(error).toBe(cause);
    expect(calls).toBe(1);
  });
});
