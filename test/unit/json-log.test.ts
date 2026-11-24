import { afterEach, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import { describeError, logJson } from '../../src/infrastructure/observability/json-log';
import { captureLogs, type LogCapture } from '../support/logs';

let capture: LogCapture | undefined;
afterEach(() => capture?.restore());

describe('logJson', () => {
  test('uma linha JSON por chamada com level, time e message; erro vai para stderr e o resto para stdout', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (stdout.push(chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (stderr.push(chunk), true)) as typeof process.stderr.write;
    try {
      logJson('info', 'a', { walletId: 'w' });
      logJson('warn', 'b');
      logJson('error', 'c', { transactionId: 't' });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      { level: 'info', time: expect.any(String), message: 'a', walletId: 'w' },
      { level: 'warn', time: expect.any(String), message: 'b' },
    ]);
    expect(stderr.map((line) => JSON.parse(line))).toEqual([{ level: 'error', time: expect.any(String), message: 'c', transactionId: 't' }]);
    expect([...stdout, ...stderr].every((line) => line.endsWith('\n') && line.indexOf('\n') === line.length - 1)).toBe(true);
  });

  test('campo undefined não vira "undefined" no JSON', () => {
    capture = captureLogs();
    logJson('info', 'x', { messageId: undefined, walletId: 'w' });
    capture.restore();
    expect(capture.lines()[0]?.json).not.toHaveProperty('messageId');
  });
});

describe('describeError (a mensagem do driver pode trazer o SQL com os valores da requisição)', () => {
  test('erro nosso: nome e mensagem', () => {
    expect(describeError(new Error('Chave de idempotência em conflito'))).toEqual({ errorName: 'Error', errorMessage: 'Chave de idempotência em conflito' });
  });

  test('erro com código (driver, rede): nome e código, NUNCA a mensagem', () => {
    const driver = Object.assign(new Error("insert into wallets values ('segredo-do-jogador', 777.77) - duplicate key"), { code: '23505' });
    expect(describeError(driver)).toEqual({ errorName: 'Error', errorCode: '23505' });
  });

  test('erro embrulhado: o nome e o código da causa aparecem, a mensagem da causa não', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    expect(describeError(new TransientInfrastructureError(cause))).toEqual({
      errorName: 'TransientInfrastructureError', errorMessage: 'Falha transitória de infraestrutura', causeName: 'Error', causeCode: 'ECONNREFUSED',
    });
  });

  test('valor que não é Error: só o tipo, nunca o conteúdo', () => {
    expect(describeError('texto-com-segredo')).toEqual({ errorName: 'string' });
    expect(describeError({ senha: 'x' })).toEqual({ errorName: 'object' });
  });
});
