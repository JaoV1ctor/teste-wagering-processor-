import { describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import { isLockConflict, isTransient, withTransientRetry } from '../../src/infrastructure/persistence/transient-retry';

const fast = { attempts: 3, baseDelayMs: 0 };
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('isTransient', () => {
  test.each(['40P01', '40001', '55P03', '57P01', '08006', 'ECONNREFUSED', 'ECONNRESET'])('%s é transitório', (code) => {
    expect(isTransient(pgError(code))).toBe(true);
  });

  // Classe 08 (exceção de conexão) e 53 (recursos insuficientes) inteiras: o Postgres pode acrescentar códigos, e todos valem reenvio.
  test.each(['08000', '08001', '08003', '08004', '08006', '08007', '08P01'])('%s (classe 08) é transitório', (code) => {
    expect(isTransient(pgError(code))).toBe(true);
  });

  test.each(['53000', '53100', '53200', '53300', '53400'])('%s (classe 53) é transitório', (code) => {
    expect(isTransient(pgError(code))).toBe(true);
  });

  test.each(['57P01', '57P02', '57P03'])('%s (servidor encerrando, reiniciando ou ainda subindo) é transitório', (code) => {
    expect(isTransient(pgError(code))).toBe(true);
  });

  test.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])('erro de rede %s SEM código, só na mensagem, é transitório', (name) => {
    expect(isTransient(new Error(`connect ${name} 127.0.0.1:5432`))).toBe(true);
  });

  test.each(['Connection terminated unexpectedly', 'timeout exceeded when trying to connect'])('mensagem do pool do pg "%s" é transitória', (message) => {
    expect(isTransient(new Error(message))).toBe(true);
  });

  test('o código pode estar na causa (erro embrulhado pelo driver ou pelo ORM)', () => {
    expect(isTransient(new Error('driver', { cause: pgError('53300') }))).toBe(true);
    expect(isTransient(new Error('driver', { cause: new Error('read ECONNRESET') }))).toBe(true);
    expect(isTransient(new Error('driver', { cause: pgError('23505') }))).toBe(false);
  });

  test.each(['23505', '23514', '22003', '42P01', '57014', '54000', '0A000'])('%s é permanente', (code) => {
    expect(isTransient(pgError(code))).toBe(false);
  });

  test('erros sem código e valores não-Error são permanentes', () => {
    expect(isTransient(new Error('bug'))).toBe(false);
    expect(isTransient(new Error('relation does not exist'))).toBe(false);
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

describe('isLockConflict (o que conta em wager_lock_conflicts_total)', () => {
  test.each(['40P01', '40001', '55P03'])('%s (deadlock, serialização, lock_timeout) é conflito de lock', (code) => {
    expect(isLockConflict(pgError(code))).toBe(true);
  });

  test.each(['57P01', '08006', '53300', '23505', 'ECONNREFUSED'])('%s é transitório (ou não) mas não é conflito de lock', (code) => {
    expect(isLockConflict(pgError(code))).toBe(false);
  });

  test('o código pode estar na causa; erro sem código e valor que não é Error não são conflito', () => {
    expect(isLockConflict(new Error('orm', { cause: pgError('40P01') }))).toBe(true);
    expect(isLockConflict(new Error('bug'))).toBe(false);
    expect(isLockConflict(undefined)).toBe(false);
  });
});

describe('onTransientFailure', () => {
  test('é chamado a cada falha transitória: willRetry true enquanto há tentativa, false na última', async () => {
    const seen: { code: unknown; willRetry: boolean }[] = [];
    const work = async () => { throw pgError('40P01'); };
    await expect(
      withTransientRetry(work, { ...fast, onTransientFailure: (error, willRetry) => seen.push({ code: (error as { code?: string }).code, willRetry }) }),
    ).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(seen).toEqual([{ code: '40P01', willRetry: true }, { code: '40P01', willRetry: true }, { code: '40P01', willRetry: false }]);
  });

  test('não é chamado em sucesso nem em erro permanente', async () => {
    const seen: unknown[] = [];
    const onTransientFailure = (error: unknown) => seen.push(error);
    expect(await withTransientRetry(async () => 'ok', { ...fast, onTransientFailure })).toBe('ok');
    await expect(withTransientRetry(async () => { throw pgError('23505'); }, { ...fast, onTransientFailure })).rejects.toThrow('pg 23505');
    expect(seen).toEqual([]);
  });

  test('uma falha seguida de sucesso: 1 chamada com willRetry true e o resultado volta', async () => {
    let calls = 0;
    const seen: boolean[] = [];
    const result = await withTransientRetry(async () => {
      calls += 1;
      if (calls === 1) throw pgError('40001');
      return 'depois';
    }, { ...fast, onTransientFailure: (_error, willRetry) => seen.push(willRetry) });
    expect(result).toBe('depois');
    expect(seen).toEqual([true]);
  });
});
