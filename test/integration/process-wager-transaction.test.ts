// ProcessWagerTransactionUseCase e repositórios de transação/wallet sobre Postgres REAL (SPEC §3 e §6). Nada é mockado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { IdempotencyConflictError, WalletNotFoundError } from '../../src/application/errors';
import { computePayloadHash } from '../../src/application/payload-hash';
import { type ProcessWagerCommand, ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';

const probe = createProbe();
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let useCase: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
  useCase = new ProcessWagerTransactionUseCase(uow);
});
afterAll(async () => {
  await probe.end();
  await orm.close();
});

const brl = (v: string) => Money.fromString(v, 'BRL');
const openWallet = (balance: string): Promise<Wallet> => new CreateWalletUseCase(uow).execute({ playerId: uuid(), initialBalance: brl(balance) });

function command(wallet: Wallet, overrides: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${uuid()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`, providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Bet, money: brl('30.00'), ...overrides,
  };
}

const rowsOf = async (sql: string, params: unknown[]) => (await probe.query(sql, params)).rows;

describe('execute — regras por operação, com o banco', () => {
  test('BET: débito, 1 lançamento DEBIT encadeado, wallet com version+1; transação gravada já PROCESSED com observed_balance e payload_hash', async () => {
    const wallet = await openWallet('100.00');
    const cmd = command(wallet);
    const { transaction, idempotentReplay } = await useCase.execute(cmd);

    expect(idempotentReplay).toBe(false);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.observedBalance?.toString()).toBe('70.00');
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect(await rowsOf('select direction, amount::text, balance_before::text, balance_after::text from wallet_ledger_entries where transaction_id = $1', [transaction.id])).toEqual([
      { direction: 'DEBIT', amount: '30.00', balance_before: '100.00', balance_after: '70.00' },
    ]);
    expect(await rowsOf('select version from wallets where id = $1', [wallet.id])).toEqual([{ version: 2 }]);
    expect(await rowsOf('select status, observed_balance::text, payload_hash, idempotency_key from wager_transactions where id = $1', [transaction.id])).toEqual([
      {
        status: 'PROCESSED', observed_balance: '70.00', idempotency_key: cmd.idempotencyKey,
        payload_hash: computePayloadHash({
          providerId: cmd.providerId, externalTransactionId: cmd.externalTransactionId, playerId: cmd.playerId, walletId: cmd.walletId,
          roundId: cmd.roundId, gameId: cmd.gameId, kind: cmd.kind, money: cmd.money.toProps(),
        }),
      },
    ]);
  });

  test('WIN credita com 1 lançamento CREDIT', async () => {
    const wallet = await openWallet('100.00');
    const { transaction } = await useCase.execute(command(wallet, { kind: WagerTransactionKind.Win, money: brl('12.34') }));
    expect(transaction.observedBalance?.toString()).toBe('112.34');
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '112.34', rebuilt: '112.34', entries: 2 });
  });

  test('LOSS grava a transação PROCESSED sem lançamento e sem tocar version', async () => {
    const wallet = await openWallet('100.00');
    const { transaction } = await useCase.execute(command(wallet, { kind: WagerTransactionKind.Loss, money: brl('999.00') }));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
    expect(await rowsOf('select version from wallets where id = $1', [wallet.id])).toEqual([{ version: 1 }]);
    expect(await rowsOf('select 1 from wallet_ledger_entries where transaction_id = $1', [transaction.id])).toHaveLength(0);
  });

  test('saldo insuficiente: REJECTED/INSUFFICIENT_BALANCE persistida (auditável), sem lançamento, wallet intacta', async () => {
    const wallet = await openWallet('10.00');
    const { transaction } = await useCase.execute(command(wallet, { money: brl('10.01') }));
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(await rowsOf('select status, failure_code, observed_balance::text, processed_at from wager_transactions where id = $1', [transaction.id])).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE', observed_balance: '10.00', processed_at: null },
    ]);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 1 });
    expect(await rowsOf('select version from wallets where id = $1', [wallet.id])).toEqual([{ version: 1 }]);
  });

  test.each([
    ['CURRENCY_MISMATCH', (w: Wallet) => command(w, { money: Money.fromString('5.00', 'USD') }), FailureCode.CurrencyMismatch],
    ['PLAYER_MISMATCH', (w: Wallet) => command(w, { playerId: uuid() }), FailureCode.PlayerMismatch],
  ])('%s: REJECTED persistida, wallet e ledger intactos', async (_name, build, code) => {
    const wallet = await openWallet('100.00');
    const { transaction } = await useCase.execute(build(wallet));
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(code);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  });

  test('wallet inexistente: WalletNotFoundError e NADA persistido', async () => {
    const cmd = command({ id: uuid(), playerId: uuid() } as Wallet);
    await expect(useCase.execute(cmd)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await rowsOf('select 1 from wager_transactions where external_transaction_id = $1', [cmd.externalTransactionId])).toHaveLength(0);
  });
});

describe('execute — idempotência', () => {
  test('mesmo comando duas vezes: 2ª é replay da MESMA transação, sem novo lançamento', async () => {
    const wallet = await openWallet('100.00');
    const cmd = command(wallet);
    const first = await useCase.execute(cmd);
    const second = await useCase.execute(cmd);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(second.transaction.toState()).toEqual(first.transaction.toState());
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('replay devolve o saldo observado na época, não o atual', async () => {
    const wallet = await openWallet('100.00');
    const cmd = command(wallet);
    await useCase.execute(cmd);
    await useCase.execute(command(wallet, { kind: WagerTransactionKind.Win, money: brl('500.00') }));
    const replay = await useCase.execute(cmd);
    expect(replay.transaction.observedBalance?.toString()).toBe('70.00');
  });

  test('replay de REJECTED devolve a rejeição original (mesmo failureCode), sem reprocessar', async () => {
    const wallet = await openWallet('10.00');
    const cmd = command(wallet, { money: brl('50.00') });
    await useCase.execute(cmd);
    await useCase.execute(command(wallet, { kind: WagerTransactionKind.Win, money: brl('500.00') }));
    const replay = await useCase.execute(cmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientBalance);
  });

  test.each([
    ['valor', { money: brl('31.00') }],
    ['tipo', { kind: WagerTransactionKind.Win }],
    ['rodada', { roundId: 'round-x' }],
    ['wallet', { walletId: uuid() }],
  ])('mesma chave com %s diferente: IdempotencyConflictError e nada muda', async (_name, change) => {
    const wallet = await openWallet('100.00');
    const cmd = command(wallet);
    await useCase.execute(cmd);
    await expect(useCase.execute({ ...cmd, ...change })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('mesmo (provider, externalTransactionId) com outra chave: IdempotencyConflictError e nada muda', async () => {
    const wallet = await openWallet('100.00');
    const cmd = command(wallet);
    await useCase.execute(cmd);
    await expect(useCase.execute({ ...cmd, idempotencyKey: `outra-${uuid()}` })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await ledgerBalance(probe, wallet.id)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('mesma chave em wallets diferentes (payload diferente) não debita nenhuma duas vezes', async () => {
    const [a, b] = await Promise.all([openWallet('100.00'), openWallet('100.00')]);
    const cmdA = command(a);
    const cmdB = { ...command(b, { externalTransactionId: cmdA.externalTransactionId }), idempotencyKey: cmdA.idempotencyKey };
    const results = await Promise.allSettled([useCase.execute(cmdA), useCase.execute(cmdB)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    const debits = (await ledgerBalance(probe, a.id)).entries + (await ledgerBalance(probe, b.id)).entries;
    expect(debits).toBe(3); // 2 OPENING + 1 débito
  });
});
