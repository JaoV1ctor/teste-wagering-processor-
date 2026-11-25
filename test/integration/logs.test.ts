// Logs estruturados (SPEC §8.4; README §12): JSON de uma linha, com correlationId/messageId/transactionId/walletId/providerId e SEM payload
// nem PII. O teste inspeciona o que a aplicação REAL escreve em stdout/stderr (Postgres real; aplicação real).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildWagerMessage } from '../../scripts/send-wager-message';
import type { UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { logJson } from '../../src/infrastructure/observability/json-log';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { ObservedProcessing } from '../../src/infrastructure/observability/observed-processing';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { WAGER_CONSUMER_NAME, WagerMessageHandler } from '../../src/interface/sqs/wager-message-handler';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema } from '../support/db';
import { type LogCapture, captureLogs } from '../support/logs';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

const probe = createProbe(2);
let api: Api;
let orm: MikroORM;
let capture: LogCapture | undefined;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
});
afterAll(async () => {
  await api.close();
  await probe.end();
  await orm.close();
});
afterEach(() => capture?.restore());

const money = (amount: string) => ({ amount, currency: 'BRL' });

/** Valores que NUNCA podem aparecer em log: ids do jogador/rodada/jogo, chave de idempotência, id do provedor, valores da aposta. */
function expectNoPayload(raw: string, secrets: string[]): void {
  for (const secret of secrets) expect(raw).not.toContain(secret);
  expect(raw).not.toContain('"amount"');
  expect(raw).not.toContain('"money"');
  expect(raw).not.toContain('"payload"');
  expect(raw).not.toContain('"body"');
}

describe('HTTP', () => {
  test('aposta processada: uma linha JSON com correlationId (header), transactionId, walletId e providerId; replay também; nada do payload', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { providerId: 'provider-secret-42', roundId: 'round-secret-7', gameId: 'game-secret-9', money: money('25.00') });
    const key = defaultKey(bet);

    capture = captureLogs();
    const first = await submit(api, bet, key, { 'x-correlation-id': 'corr-http-77' });
    const replay = await submit(api, bet, key, { 'x-correlation-id': 'corr-http-78' });
    capture.restore();

    expect(first.status).toBe(201);
    expect(replay.body.idempotentReplay).toBe(true);
    const lines = capture.lines();
    for (const line of lines) expect(line.json).toMatchObject({ level: expect.stringMatching(/^(info|warn|error)$/), time: expect.any(String), message: expect.any(String) });

    expect(capture.named('wager_transaction_processed')).toEqual([
      expect.objectContaining({
        level: 'info', correlationId: 'corr-http-77', transactionId: first.body.transactionId, walletId: wallet.walletId, providerId: 'provider-secret-42',
        kind: 'BET', status: 'PROCESSED',
      }),
    ]);
    expect(capture.named('wager_transaction_replayed')).toEqual([
      expect.objectContaining({ correlationId: 'corr-http-78', transactionId: first.body.transactionId, walletId: wallet.walletId, providerId: 'provider-secret-42' }),
    ]);
    expectNoPayload(lines.map((line) => line.raw).join('\n'), [wallet.playerId, 'round-secret-7', 'game-secret-9', key, bet.externalTransactionId, '25.00']);
  });

  test('sem x-correlation-id o correlationId é o id da transação', async () => {
    const wallet = await openWallet(api, '100.00');
    capture = captureLogs();
    const bet = wagerPayload(wallet);
    const res = await submit(api, bet, defaultKey(bet));
    capture.restore();
    expect(capture.named('wager_transaction_processed')[0]).toMatchObject({ correlationId: res.body.transactionId });
  });

  test('rejeição de negócio: loga o status e o failureCode, sem o payload', async () => {
    const wallet = await openWallet(api, '10.00');
    const bet = wagerPayload(wallet, { money: money('500.00') });
    capture = captureLogs();
    await submit(api, bet, defaultKey(bet));
    capture.restore();
    expect(capture.named('wager_transaction_processed')[0]).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE', walletId: wallet.walletId });
    expectNoPayload(capture.lines().map((line) => line.raw).join('\n'), [wallet.playerId, '500.00']);
  });

  test('falha 5xx (Postgres fora do ar): request_failed em JSON com o correlationId, sem o corpo da requisição nem a mensagem do driver', async () => {
    const broken = await startApi({ DATABASE_URL: 'postgres://wager:wager@127.0.0.1:9/wager' });
    try {
      const playerId = uuid();
      capture = captureLogs();
      const res = await broken.call('POST', '/wallets', { playerId, initialBalance: money('777.77') }, { 'x-correlation-id': 'corr-fail-1' });
      capture.restore();
      expect(res.status).toBe(503);
      const [log] = capture.named('request_failed');
      expect(log).toMatchObject({ level: 'error', status: 503, correlationId: 'corr-fail-1', errorName: 'TransientInfrastructureError' });
      expectNoPayload(capture.lines().map((line) => line.raw).join('\n'), [playerId, '777.77']);
    } finally {
      await broken.close();
    }
  });
});

describe('SQS (o mesmo caso de uso, pelo handler real)', () => {
  const handlerOf = () => {
    const uow = new MikroOrmUnitOfWork(orm);
    const useCase = new ProcessWagerTransactionUseCase(uow, undefined, undefined, new ObservedProcessing(new Metrics(), logJson));
    return new WagerMessageHandler(useCase, { consumerName: WAGER_CONSUMER_NAME, backoff: { baseSeconds: 1, maxSeconds: 1 }, log: logJson });
  };

  test('mensagem processada: messageId é o correlationId e aparece junto de transactionId, walletId e providerId; nada do payload', async () => {
    const wallet = await openWallet(api, '100.00');
    const message = buildWagerMessage({
      providerId: 'provider-sqs-secret', playerId: wallet.playerId, walletId: wallet.walletId, roundId: 'round-sqs-secret', gameId: 'game-sqs-secret',
      kind: 'BET', amount: '33.30', currency: 'BRL',
    });

    capture = captureLogs();
    const disposition = await handlerOf().handle(JSON.stringify(message), 1);
    capture.restore();

    expect(disposition).toEqual({ action: 'ack' });
    expect(capture.named('wager_transaction_processed')).toEqual([
      expect.objectContaining({
        correlationId: message.messageId, messageId: message.messageId, walletId: wallet.walletId, providerId: 'provider-sqs-secret',
        transactionId: expect.any(String), status: 'PROCESSED', kind: 'BET',
      }),
    ]);
    expectNoPayload(capture.lines().map((line) => line.raw).join('\n'), [wallet.playerId, 'round-sqs-secret', 'game-sqs-secret', message.data.externalTransactionId, '33.30']);
  });

  test('a mesma mensagem de novo: wager_message_duplicate ou replay, ainda com messageId e sem payload', async () => {
    const wallet = await openWallet(api, '100.00');
    const message = buildWagerMessage({
      providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.walletId, roundId: 'r', gameId: 'g', kind: 'BET', amount: '5.00', currency: 'BRL',
    });
    const handler = handlerOf();
    await handler.handle(JSON.stringify(message), 1);

    capture = captureLogs();
    await handler.handle(JSON.stringify(message), 2);
    capture.restore();

    const [log] = [...capture.named('wager_transaction_replayed'), ...capture.named('wager_message_duplicate')];
    expect(log).toMatchObject({ messageId: message.messageId, correlationId: message.messageId, walletId: wallet.walletId, providerId: 'provider-a' });
  });

  test('mensagem malformada: falha permanente logada sem o corpo recebido', async () => {
    capture = captureLogs();
    const disposition = await handlerOf().handle('{"segredo":"valor-que-nao-pode-vazar"', 1);
    capture.restore();
    expect(disposition).toMatchObject({ action: 'dead-letter', reason: 'MALFORMED_MESSAGE' });
    expect(capture.named('wager_message_permanent_failure')).toHaveLength(1);
    expectNoPayload(capture.lines().map((line) => line.raw).join('\n'), ['valor-que-nao-pode-vazar']);
  });
});

describe('texto de exceção que carrega dado sensível não chega à saída', () => {
  const MARKER = 'segredo-7f3a9c';
  /** Como um erro do ORM ou de biblioteca pode vir: sem `code`, com o SQL e os valores na mensagem. */
  const leaky = () => new Error(`insert into wallet_ledger_entries (player_id) values ('${MARKER}') falhou`);
  const output = () => capture?.lines().map((line) => line.raw).join('\n') ?? '';
  const handlerOver = (uow: UnitOfWork) =>
    new WagerMessageHandler(new ProcessWagerTransactionUseCase(uow), {
      consumerName: WAGER_CONSUMER_NAME, backoff: { baseSeconds: 1, maxSeconds: 1 }, log: logJson,
    });

  test('SQS: exceção do repositório no meio do processamento (UNEXPECTED_ERROR) loga o nome, nunca a mensagem', async () => {
    const wallet = await openWallet(api, '100.00');
    const real = new MikroOrmUnitOfWork(orm);
    const broken: UnitOfWork = {
      read: (work) => real.read(work),
      run: (work) =>
        real.run((repos) => work({ ...repos, ledger: Object.assign(Object.create(repos.ledger), { add: async () => { throw leaky(); } }) })),
    };
    const message = buildWagerMessage({
      providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.walletId, roundId: 'r', gameId: 'g', kind: 'BET', amount: '5.00', currency: 'BRL',
    });

    capture = captureLogs();
    const disposition = await handlerOver(broken).handle(JSON.stringify(message), 1);
    capture.restore();

    expect(disposition).toEqual({ action: 'dead-letter', reason: 'UNEXPECTED_ERROR' });
    expect(capture.named('wager_message_permanent_failure')).toEqual([expect.objectContaining({ errorName: 'Error', messageId: message.messageId })]);
    expect(output()).not.toContain(MARKER);
  });

  test('SQS: o type desconhecido é texto do produtor e não é repetido no log', async () => {
    const body = JSON.stringify({ messageId: 'm-tipo', type: MARKER, occurredAt: new Date().toISOString(), data: {} });

    capture = captureLogs();
    const disposition = await handlerOver(new MikroOrmUnitOfWork(orm)).handle(body, 1);
    capture.restore();

    expect(disposition).toEqual({ action: 'dead-letter', reason: 'UNKNOWN_MESSAGE_TYPE' });
    expect(capture.named('wager_message_permanent_failure')).toEqual([expect.objectContaining({ errorName: 'UnknownMessageTypeError' })]);
    expect(output()).not.toContain(MARKER);
  });

  test('HTTP: 500 por exceção sem código loga request_failed com o nome; nem o log nem a resposta repetem a mensagem', async () => {
    const wallet = await openWallet(api, '100.00');
    const useCase = api.app.get(ProcessWagerTransactionUseCase);
    const original = useCase.execute;
    useCase.execute = (async () => { throw leaky(); }) as typeof original;
    try {
      const bet = wagerPayload(wallet);
      capture = captureLogs();
      const res = await submit(api, bet, defaultKey(bet), { 'x-correlation-id': 'corr-leak-1' });
      capture.restore();

      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(MARKER);
      expect(capture.named('request_failed')).toEqual([expect.objectContaining({ errorName: 'Error', correlationId: 'corr-leak-1' })]);
      expect(output()).not.toContain(MARKER);
    } finally {
      useCase.execute = original;
    }
  });

  test('o logger do Nest recebendo um Error também não repete a mensagem', () => {
    capture = captureLogs();
    new JsonLogger().error(leaky(), 'stack', 'Ctx');
    capture.restore();
    expect(output()).not.toContain(MARKER);
  });
});

describe('um único ponto de configuração do logger', () => {
  test('o logger do Nest (boot, erros do framework) também escreve JSON de uma linha pelo mesmo logJson', () => {
    capture = captureLogs();
    const logger = new JsonLogger();
    logger.log('Nest application successfully started', 'NestApplication');
    logger.warn('aviso', 'Ctx');
    logger.error('falhou', 'stack-trace-ignorado', 'Ctx');
    capture.restore();

    expect(capture.lines().map((line) => line.json)).toEqual([
      expect.objectContaining({ level: 'info', message: 'Nest application successfully started', context: 'NestApplication' }),
      expect.objectContaining({ level: 'warn', message: 'aviso', context: 'Ctx' }),
      expect.objectContaining({ level: 'error', message: 'falhou', context: 'Ctx' }),
    ]);
  });
});
