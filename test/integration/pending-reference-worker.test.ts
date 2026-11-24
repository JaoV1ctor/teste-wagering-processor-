// Worker de PENDING_REFERENCE (SPEC §8.3, §3.10; README §7.1) e cenário #7 (SPEC §10). Postgres REAL; a API é a aplicação de verdade.
// O tempo é simulado por um relógio injetado e congelado: o teste decide quando as tentativas vencem (nada de sleep).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { type ReprocessOptions, ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import type { Repositories, UnitOfWork } from '../../src/application/ports';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { PollingWorker } from '../../src/infrastructure/workers/polling-worker';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance, parkPendingReferences } from '../support/db';
import { defaultKey, openWallet, reversalPayload, submit, type WagerPayload, wagerPayload } from '../support/wager';

const probe = createProbe();
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let api: Api;
let simulatedNow = 0;
const clock = () => new Date(simulatedNow);
/** Adianta o relógio do worker; as tentativas pendentes (agendadas no máximo ~90s à frente) vencem. */
const advance = (ms = 120_000) => { simulatedNow += ms; };

beforeAll(async () => {
  await ensureSchema();
  orm = await MikroORM.init({ ...createOrmConfig(), extensions: [Migrator] });
  uow = new MikroOrmUnitOfWork(orm);
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
  await orm.close();
});
// Pendentes deixadas por outros testes não vencem mais: cada teste só enxerga as suas.
beforeEach(async () => {
  await parkPendingReferences(probe);
  simulatedNow = Date.now() + 60_000;
});

type Wallet = { walletId: string; playerId: string };
const money = (amount: string) => ({ amount, currency: 'BRL' });
const post = (payload: WagerPayload) => submit(api, payload, defaultKey(payload));
const state = (wallet: Wallet) => ledgerBalance(probe, wallet.walletId);
/** Por padrão uma falha por transação derruba o teste (nunca é engolida); o teste de falha injeta o seu próprio onError. */
const rethrow = (error: unknown): never => {
  throw error;
};
const worker = (uowOverride: UnitOfWork = uow, extra: Partial<ReprocessOptions> = {}) =>
  new ReprocessPendingReferencesUseCase(uowOverride, { onError: rethrow, clock, random: () => 0, batchSize: 100, ...extra });

async function row(transactionId: string) {
  const { rows } = await probe.query(
    `select status, attempts, failure_code, reference_transaction_id, next_attempt_at, observed_balance::text as observed_balance
       from wager_transactions where id = $1`, [transactionId]);
  return rows[0] as {
    status: string; attempts: number; failure_code: string | null; reference_transaction_id: string | null; next_attempt_at: Date | null; observed_balance: string | null;
  };
}

describe('cenário #7: reversão antes da referência => PENDING_REFERENCE => a referência chega => o worker resolve', () => {
  test('REFUND antes da BET: 202; sem a BET o worker só reagenda; com a BET resolve como PROCESSED com crédito e ledger', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const refund = reversalPayload(wallet, bet, 'REFUND');

    const early = await post(refund);
    expect(early.status).toBe(202);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });

    expect(await worker().runOnce()).toEqual({ claimed: 1, processed: 0, rejected: 0, rescheduled: 1, skipped: 0, failed: 0 });
    expect(await row(early.body.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2 });
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });

    const betRes = await post(bet);
    expect(betRes.status).toBe(201); // saldo 70,00
    advance();
    expect(await worker().runOnce()).toEqual({ claimed: 1, processed: 1, rejected: 0, rescheduled: 0, skipped: 0, failed: 0 });

    expect(await row(early.body.transactionId)).toMatchObject({
      status: 'PROCESSED', reference_transaction_id: betRes.body.transactionId, observed_balance: '100.00', failure_code: null,
    });
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    const { rows: ledger } = await probe.query('select direction, amount::text from wallet_ledger_entries where transaction_id = $1', [early.body.transactionId]);
    expect(ledger).toEqual([{ direction: 'CREDIT', amount: '30.00' }]);

    // Replay depois de resolvida: devolve o estado atual da transação (PROCESSED), não o 202 antigo.
    const replay = await post(refund);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ transactionId: early.body.transactionId, status: 'PROCESSED', balance: money('100.00'), idempotentReplay: true });
  });

  test('ROLLBACK antes da WIN: o worker resolve com DÉBITO (inverso da referência)', async () => {
    const wallet = await openWallet(api, '100.00');
    const win = wagerPayload(wallet, { kind: 'WIN', money: money('50.00') });
    const rollback = reversalPayload(wallet, win, 'ROLLBACK');

    expect((await post(rollback)).status).toBe(202);
    expect((await post(win)).status).toBe(201); // 150,00
    advance();
    expect(await worker().runOnce()).toMatchObject({ claimed: 1, processed: 1 });

    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    const replay = await post(rollback);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: money('100.00'), idempotentReplay: true });
  });

  test('WIN com referência antes da BET: o worker credita ao resolver', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const win = wagerPayload(wallet, { kind: 'WIN', money: money('80.00'), referenceExternalTransactionId: bet.externalTransactionId });

    expect((await post(win)).status).toBe(202);
    await post(bet); // 70,00
    advance();
    await worker().runOnce();
    expect(await state(wallet)).toEqual({ stored: '150.00', rebuilt: '150.00', entries: 3 });
  });

  test('cadeia: ROLLBACK espera uma WIN que espera a BET; as duas resolvem em reprocessamentos sucessivos', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const win = wagerPayload(wallet, { kind: 'WIN', money: money('80.00'), referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = reversalPayload(wallet, win, 'ROLLBACK');
    const winRes = await post(win);
    const rollbackRes = await post(rollback);
    expect([winRes.status, rollbackRes.status]).toEqual([202, 202]);
    await post(bet); // 70,00

    for (let pass = 0; pass < 3; pass += 1) {
      advance();
      await worker().runOnce();
    }
    expect((await row(winRes.body.transactionId)).status).toBe('PROCESSED');
    expect((await row(rollbackRes.body.transactionId)).status).toBe('PROCESSED');
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 4 }); // 100 - 30 + 80 - 80
  });

  test('a referência chega mas viola uma regra: REJECTED com o código da regra, sem ledger; o replay devolve 422', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const refund = reversalPayload(wallet, bet, 'REFUND', { money: money('29.00') });
    const early = await post(refund);
    await post(bet);
    advance();
    expect(await worker().runOnce()).toMatchObject({ claimed: 1, rejected: 1 });

    expect(await row(early.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH', observed_balance: '70.00' });
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    const replay = await post(refund);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: 'AMOUNT_MISMATCH', idempotentReplay: true });
  });

  test('duas reversões pendentes da mesma BET: o worker efetiva UMA e rejeita a outra com ALREADY_REVERSED', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const refund = await post(reversalPayload(wallet, bet, 'REFUND'));
    const rollback = await post(reversalPayload(wallet, bet, 'ROLLBACK'));
    await post(bet);
    advance();
    expect(await worker().runOnce()).toMatchObject({ claimed: 2, processed: 1, rejected: 1 });

    const rows = [await row(refund.body.transactionId), await row(rollback.body.transactionId)];
    expect(rows.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(rows.find((r) => r.status === 'REJECTED')?.failure_code).toBe('ALREADY_REVERSED');
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('ROLLBACK pendente de WIN cujo prêmio já foi gasto: REJECTED/REVERSAL_WOULD_OVERDRAW', async () => {
    const wallet = await openWallet(api, '100.00');
    const win = wagerPayload(wallet, { kind: 'WIN', money: money('50.00') });
    const early = await post(reversalPayload(wallet, win, 'ROLLBACK'));
    await post(win); // 150,00
    await post(wagerPayload(wallet, { money: money('140.00') })); // 10,00
    advance();
    await worker().runOnce();

    expect(await row(early.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REVERSAL_WOULD_OVERDRAW', observed_balance: '10.00' });
    expect(await state(wallet)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 3 });
  });
});

describe('limite de tentativas (SPEC §3.10): 1 avaliação inicial + 8 reprocessamentos', () => {
  test('o agendamento recua 2s, 4s, 8s, 16s, 32s e 60s (teto) a cada reprocessamento sem referência', async () => {
    const wallet = await openWallet(api, '100.00');
    const early = await post(wagerPayload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-que-nunca-chega' }));
    expect((await row(early.body.transactionId)).attempts).toBe(1);

    const expectedDelays = [2000, 4000, 8000, 16000, 32000, 60000, 60000]; // reprocessamentos 1 a 7 (attempts 2 a 8)
    for (const [i, expected] of expectedDelays.entries()) {
      advance();
      expect(await worker().runOnce()).toMatchObject({ claimed: 1, rescheduled: 1, rejected: 0 });
      const current = await row(early.body.transactionId);
      expect(current).toMatchObject({ status: 'PENDING_REFERENCE', attempts: i + 2 });
      expect((current.next_attempt_at as Date).getTime() - simulatedNow).toBe(expected);
    }
  });

  test('o 8º reprocessamento sem referência: REJECTED/REFERENCE_NOT_FOUND, saldo observado, replay 422; depois enviar a BET e uma NOVA reversão funciona', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const refund = reversalPayload(wallet, bet, 'REFUND');
    const early = await post(refund);

    for (let i = 0; i < 7; i += 1) {
      advance();
      await worker().runOnce();
      expect((await row(early.body.transactionId)).status).toBe('PENDING_REFERENCE');
    }
    advance();
    expect(await worker().runOnce()).toEqual({ claimed: 1, processed: 0, rejected: 1, rescheduled: 0, skipped: 0, failed: 0 });
    expect(await row(early.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', observed_balance: '100.00', attempts: 8 });
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });

    const replay = await post(refund);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ transactionId: early.body.transactionId, status: 'REJECTED', balance: money('100.00'), idempotentReplay: true, failureCode: 'REFERENCE_NOT_FOUND' });

    // Ação prescrita na SPEC §5.1: enviar a transação referenciada e uma nova reversão (novo externalTransactionId).
    expect((await post(bet)).status).toBe(201);
    const again = await post(reversalPayload(wallet, bet, 'REFUND'));
    expect(again.status).toBe(201);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('nada ainda vencido: o worker não reivindica nem altera', async () => {
    const wallet = await openWallet(api, '100.00');
    const early = await post(wagerPayload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-futura' }));
    simulatedNow = Date.now() - 3_600_000; // uma hora ATRÁS: nada venceu
    const before = await row(early.body.transactionId);
    expect(await worker().runOnce()).toEqual({ claimed: 0, processed: 0, rejected: 0, rescheduled: 0, skipped: 0, failed: 0 });
    expect(await row(early.body.transactionId)).toEqual(before);
  });
});

describe('claim por lease', () => {
  test('o claim agenda a transação para depois do lease: uma segunda execução não a pega; vencido o lease, ela volta (recuperação de crash)', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const early = await post(reversalPayload(wallet, bet, 'REFUND'));
    await post(bet);

    // "Worker que morreu": reivindica e não processa.
    const claimed = await uow.run(({ transactions }) => transactions.claimDuePendingReference(clock(), 10, new Date(simulatedNow + 30_000)));
    expect(claimed).toEqual([{ id: early.body.transactionId, walletId: wallet.walletId }]);
    expect((await row(early.body.transactionId)).next_attempt_at?.getTime()).toBe(simulatedNow + 30_000);

    expect(await worker().runOnce()).toMatchObject({ claimed: 0 }); // lease ainda vale
    expect((await row(early.body.transactionId)).status).toBe('PENDING_REFERENCE');

    advance(31_000); // lease vencido
    expect(await worker().runOnce()).toMatchObject({ claimed: 1, processed: 1 });
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('só PENDING_REFERENCE é reivindicada (PROCESSED e REJECTED nunca)', async () => {
    const wallet = await openWallet(api, '10.00');
    await post(wagerPayload(wallet, { money: money('1.00') })); // PROCESSED
    await post(wagerPayload(wallet, { money: money('50.00') })); // REJECTED
    advance();
    expect(await worker().runOnce()).toMatchObject({ claimed: 0 });
  });

  test('o tamanho do lote limita o claim', async () => {
    const wallet = await openWallet(api, '100.00');
    for (let i = 0; i < 5; i += 1) await post(wagerPayload(wallet, { kind: 'REFUND', referenceExternalTransactionId: `ausente-${uuid()}` }));
    advance();
    expect(await worker(uow, { batchSize: 2 }).runOnce()).toMatchObject({ claimed: 2, rescheduled: 2 });
  });
});

describe('falha ao reprocessar uma transação', () => {
  /** UnitOfWork real (mesma transação SQL) cujo lock da wallet indicada lança: simula um erro de infraestrutura/bug naquela transação. */
  function failingForWallet(walletId: string, boom: Error): UnitOfWork {
    return {
      read: (work) => uow.read(work),
      run: (work) =>
        uow.run((repos: Repositories) => {
          const wallets = Object.assign(Object.create(repos.wallets), {
            lockWallet: async (id: string) => {
              if (id === walletId) throw boom;
              return repos.wallets.lockWallet(id);
            },
          });
          return work({ ...repos, wallets });
        }),
    };
  }

  test('o erro não é engolido (onError + contagem), as outras transações seguem, e a falhada fica elegível após o lease', async () => {
    const good = await openWallet(api, '100.00');
    const bad = await openWallet(api, '100.00');
    const goodBet = wagerPayload(good, { money: money('10.00') });
    const badBet = wagerPayload(bad, { money: money('10.00') });
    const goodRefund = await post(reversalPayload(good, goodBet, 'REFUND'));
    const badRefund = await post(reversalPayload(bad, badBet, 'REFUND'));
    await post(goodBet);
    await post(badBet);
    advance();

    const boom = new Error('falha injetada');
    const reported: { error: unknown; transactionId: string }[] = [];
    const summary = await worker(failingForWallet(bad.walletId, boom), { onError: (error, context) => reported.push({ error, transactionId: context.id }) }).runOnce();

    expect(summary).toMatchObject({ claimed: 2, processed: 1, failed: 1 });
    expect(reported).toEqual([{ error: boom, transactionId: badRefund.body.transactionId }]);
    expect((await row(goodRefund.body.transactionId)).status).toBe('PROCESSED');
    expect((await row(badRefund.body.transactionId)).status).toBe('PENDING_REFERENCE');
    expect(await state(bad)).toEqual({ stored: '90.00', rebuilt: '90.00', entries: 2 }); // só a BET; nada pela metade

    advance(31_000);
    expect(await worker().runOnce()).toMatchObject({ claimed: 1, processed: 1 });
    expect(await state(bad)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('transação já resolvida entre o claim e o processamento é pulada (skipped), sem alterar nada', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const early = await post(reversalPayload(wallet, bet, 'REFUND'));
    await post(bet);
    advance();
    await worker().runOnce(); // resolve
    const before = await row(early.body.transactionId);

    const outcome = await worker().reprocessOne({ id: early.body.transactionId, walletId: wallet.walletId });
    expect(outcome).toBe('skipped');
    expect(await row(early.body.transactionId)).toEqual(before);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });
});

describe('loop periódico (PollingWorker) com o banco real', () => {
  test('start() resolve a pendência em background assim que ela vence; stop() espera a execução corrente e encerra o loop', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    const early = await post(reversalPayload(wallet, bet, 'REFUND'));
    await post(bet);

    // Relógio real: a tentativa vence em ~1s; o teste espera a CONDIÇÃO (com prazo), não um tempo fixo.
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    const loop = new PollingWorker(new ReprocessPendingReferencesUseCase(uow, { batchSize: 10, onError }), { pollIntervalMs: 25, batchSize: 10, onError });
    loop.start();
    try {
      const deadline = Date.now() + 15_000;
      while ((await row(early.body.transactionId)).status !== 'PROCESSED' && Date.now() < deadline) await Bun.sleep(50);
    } finally {
      await loop.stop();
    }

    expect((await row(early.body.transactionId)).status).toBe('PROCESSED');
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    expect(loop.isRunning).toBe(false);
    expect(errors).toEqual([]);
  });
});
