import { afterEach, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError, InboxPayloadConflictError, InvalidCursorError, TransientInfrastructureError, WagerTransactionNotFoundError,
  WalletAlreadyExistsError, WalletNotFoundError,
} from '../../src/application/errors';
import {
  CurrencyMismatchError, InsufficientBalanceError, InvalidInboxMessageError, InvalidIntegrationEventError, InvalidOutboxMessageError,
  InvalidTransactionStateError, InvalidWagerTransactionError, LedgerEntryNotBalancedError, MoneyOverflowError,
} from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { ConfigurationError, requireEnv } from '../../src/infrastructure/env';
import { describeError, logJson } from '../../src/infrastructure/observability/json-log';
import { UnknownMessageTypeError } from '../../src/interface/sqs/wager-transaction-message';
import { captureLogs, type LogCapture } from '../support/logs';

let capture: LogCapture | undefined;
afterEach(() => capture?.restore());

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('nada foi lançado');
}

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
  test.each([
    new WalletNotFoundError('w-1'), new WalletAlreadyExistsError(), new IdempotencyConflictError(), new WagerTransactionNotFoundError(),
    new InvalidCursorError(), new InboxPayloadConflictError('msg-1'), new InsufficientBalanceError(), new MoneyOverflowError(),
    new LedgerEntryNotBalancedError(), new InvalidWagerTransactionError('LOSS não move saldo'),
    new InvalidTransactionStateError('t-1', 'PROCESSED', 'reject'), new InvalidInboxMessageError('Mensagem já marcada como processada'),
    new InvalidOutboxMessageError('Evento e-1 já foi publicado'), new InvalidIntegrationEventError('O lançamento pertence a outra wallet'),
    new ConfigurationError('Variável de ambiente ausente: DATABASE_URL'),
  ])('classe nossa da lista permitida: nome e mensagem (%#)', (error) => {
    expect(describeError(error)).toEqual({ errorName: error.name, errorMessage: error.message });
    expect(error.name).toBe(error.constructor.name);
  });

  test('erro sem código fora da lista: só o nome, NUNCA a mensagem', () => {
    expect(describeError(new Error("insert into wallets values ('segredo', 777.77)"))).toEqual({ errorName: 'Error' });
    expect(describeError(new TypeError('não é possível ler "segredo"'))).toEqual({ errorName: 'TypeError' });
  });

  test('erros nossos cuja mensagem repete a entrada ficam fora da lista', () => {
    expect(describeError(thrownBy(() => Money.fromString('777.77segredo', 'BRL')))).toEqual({ errorName: 'InvalidMoneyError' });
    expect(describeError(new CurrencyMismatchError('BRL', 'segredo'))).toEqual({ errorName: 'CurrencyMismatchError' });
    expect(describeError(new UnknownMessageTypeError('segredo'))).toEqual({ errorName: 'UnknownMessageTypeError' });
  });

  test('a lista é por classe exata: uma subclasse de uma classe permitida não herda a permissão', () => {
    class LeakyConflict extends IdempotencyConflictError {
      override readonly message = 'segredo';
    }
    expect(describeError(new LeakyConflict())).toEqual({ errorName: 'LeakyConflict' });
  });

  test('requireEnv falha com um erro cuja mensagem (só o nome da variável) continua no log de boot', () => {
    expect(describeError(thrownBy(() => requireEnv('VARIAVEL_QUE_NAO_EXISTE')))).toEqual({
      errorName: 'ConfigurationError', errorMessage: 'Variável de ambiente ausente: VARIAVEL_QUE_NAO_EXISTE (copie .env.example para .env)',
    });
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
