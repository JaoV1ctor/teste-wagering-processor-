// REFUND/ROLLBACK e referências: regras de reversão 1 a 9 do enunciado, pela API real sobre Postgres REAL.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { defaultKey, openWallet, reversalPayload, submit, type WagerPayload, wagerPayload } from '../support/wager';

const probe = createProbe();
let api: Api;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
});

type Wallet = { walletId: string; playerId: string };
const money = (amount: string, currency = 'BRL') => ({ amount, currency });
const post = (payload: WagerPayload) => submit(api, payload, defaultKey(payload));
const rows = async (sql: string, params: unknown[]) => (await probe.query(sql, params)).rows;
const state = (wallet: Wallet) => ledgerBalance(probe, wallet.walletId);

/** Envia uma operação que TEM de ser processada (201) e devolve payload e corpo. */
async function processed(wallet: Wallet, kind: string, amount: string, overrides: Partial<WagerPayload> = {}) {
  const payload = wagerPayload(wallet, { kind, money: money(amount), ...overrides });
  const res = await post(payload);
  expect(res.status).toBe(201);
  return { payload, body: res.body };
}

/** Wallet com saldo 100,00 e uma BET de 30,00 processada (saldo 70,00). */
async function walletWithBet() {
  const wallet = await openWallet(api, '100.00');
  const bet = await processed(wallet, 'BET', '30.00');
  return { wallet, bet: bet.payload, betId: bet.body.transactionId as string };
}

const rejected = (res: { status: number; body: { status: string; failureCode?: string } }, code: string) => {
  expect(res.status).toBe(422);
  expect(res.body.status).toBe('REJECTED');
  expect(res.body.failureCode).toBe(code);
};

describe('efeito no saldo: ROLLBACK é o inverso da referência', () => {
  test('REFUND de BET PROCESSED: crédito de 30,00, 1 lançamento CREDIT, referência gravada, 201', async () => {
    const { wallet, bet, betId } = await walletWithBet();
    const res = await post(reversalPayload(wallet, bet, 'REFUND'));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: money('100.00'), idempotentReplay: false });
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    expect(await rows('select direction, amount::text, balance_before::text, balance_after::text from wallet_ledger_entries where transaction_id = $1', [res.body.transactionId])).toEqual([
      { direction: 'CREDIT', amount: '30.00', balance_before: '70.00', balance_after: '100.00' },
    ]);
    expect(await rows('select reference_transaction_id, reference_external_transaction_id from wager_transactions where id = $1', [res.body.transactionId])).toEqual([
      { reference_transaction_id: betId, reference_external_transaction_id: bet.externalTransactionId },
    ]);
  });

  test('ROLLBACK de BET: crédito', async () => {
    const { wallet, bet } = await walletWithBet();
    const res = await post(reversalPayload(wallet, bet, 'ROLLBACK'));
    expect(res.status).toBe(201);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('ROLLBACK de WIN: débito', async () => {
    const wallet = await openWallet(api, '100.00');
    const win = (await processed(wallet, 'WIN', '50.00')).payload;
    const res = await post(reversalPayload(wallet, win, 'ROLLBACK'));

    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(money('100.00'));
    expect(await rows('select direction from wallet_ledger_entries where transaction_id = $1', [res.body.transactionId])).toEqual([{ direction: 'DEBIT' }]);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test('ROLLBACK de REFUND: débito (desfaz o crédito do REFUND)', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = reversalPayload(wallet, bet, 'REFUND');
    expect((await post(refund)).status).toBe(201); // 100,00
    const res = await post(reversalPayload(wallet, refund, 'ROLLBACK'));

    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(money('70.00'));
    expect(await rows('select direction from wallet_ledger_entries where transaction_id = $1', [res.body.transactionId])).toEqual([{ direction: 'DEBIT' }]);
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 4 });
  });

  test('ROLLBACK de ROLLBACK: REJECTED/INVALID_REFERENCE_KIND, sem efeito', async () => {
    const { wallet, bet } = await walletWithBet();
    const first = reversalPayload(wallet, bet, 'ROLLBACK');
    expect((await post(first)).status).toBe(201);
    const res = await post(reversalPayload(wallet, first, 'ROLLBACK'));

    rejected(res, 'INVALID_REFERENCE_KIND');
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });
});

describe('regra 1: REFUND e ROLLBACK exigem referenceExternalTransactionId', () => {
  test.each(['REFUND', 'ROLLBACK'])('%s sem referência: 400 e nada persistido', async (kind) => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { kind });
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.details)).toMatch(/referenceExternalTransactionId/);
    expect(await rows('select 1 from wager_transactions where external_transaction_id = $1', [payload.externalTransactionId])).toHaveLength(0);
  });

  test('BET com referência e referência para si mesma: 400', async () => {
    const wallet = await openWallet(api, '100.00');
    expect((await post(wagerPayload(wallet, { kind: 'BET', referenceExternalTransactionId: 'x' }))).status).toBe(400);
    const self = wagerPayload(wallet, { kind: 'REFUND', externalTransactionId: 'mesmo-id', referenceExternalTransactionId: 'mesmo-id' });
    expect((await post(self)).status).toBe(400);
  });
});

describe('regra 2: referência por (providerId, id externo), mesmo provider, player, wallet, moeda e rodada', () => {
  test('o mesmo id externo em OUTRO provider não é a referência: fica 202 PENDING_REFERENCE', async () => {
    const { wallet, bet } = await walletWithBet();
    const res = await post(reversalPayload(wallet, bet, 'REFUND', { providerId: 'provider-b' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('referência em OUTRA wallet do mesmo provider: REJECTED/REFERENCE_MISMATCH; nenhuma das duas wallets muda', async () => {
    const { wallet: a, bet } = await walletWithBet();
    const b = await openWallet(api, '100.00');
    const res = await post(reversalPayload(b, bet, 'REFUND'));

    rejected(res, 'REFERENCE_MISMATCH');
    expect(await state(a)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect(await state(b)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  });

  test('outra rodada: REJECTED/REFERENCE_MISMATCH', async () => {
    const { wallet, bet } = await walletWithBet();
    rejected(await post(reversalPayload(wallet, bet, 'REFUND', { roundId: 'round-outra' })), 'REFERENCE_MISMATCH');
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('player diferente do dono da wallet: PLAYER_MISMATCH; moeda diferente da wallet: CURRENCY_MISMATCH (checados antes da referência)', async () => {
    const { wallet, bet } = await walletWithBet();
    rejected(await post(reversalPayload(wallet, bet, 'REFUND', { playerId: uuid() })), 'PLAYER_MISMATCH');
    rejected(await post(reversalPayload(wallet, bet, 'REFUND', { money: money('30.00', 'USD') })), 'CURRENCY_MISMATCH');
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });
});

describe('regra 3: tipos referenciáveis', () => {
  test.each([
    ['REFUND', 'WIN'], ['REFUND', 'LOSS'], ['ROLLBACK', 'LOSS'],
  ])('%s de %s: REJECTED/INVALID_REFERENCE_KIND', async (kind, referenced) => {
    const wallet = await openWallet(api, '100.00');
    const reference = (await processed(wallet, referenced, '10.00')).payload;
    const before = await state(wallet);
    rejected(await post(reversalPayload(wallet, reference, kind as 'REFUND' | 'ROLLBACK')), 'INVALID_REFERENCE_KIND');
    expect(await state(wallet)).toEqual(before);
  });

  test('REFUND de REFUND: INVALID_REFERENCE_KIND (REFUND só referencia BET)', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = reversalPayload(wallet, bet, 'REFUND');
    await post(refund);
    rejected(await post(reversalPayload(wallet, refund, 'REFUND')), 'INVALID_REFERENCE_KIND');
  });

  test('referência REJECTED: REFERENCE_NOT_PROCESSED (não há o que reverter)', async () => {
    const wallet = await openWallet(api, '10.00');
    const bet = wagerPayload(wallet, { money: money('50.00') });
    expect((await post(bet)).status).toBe(422); // INSUFFICIENT_BALANCE
    rejected(await post(reversalPayload(wallet, bet, 'REFUND')), 'REFERENCE_NOT_PROCESSED');
    expect(await state(wallet)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 1 });
  });
});

describe('regra 4: no máximo UMA reversão efetiva por transação referenciada', () => {
  test('REFUND duas vezes (ids externos diferentes): o 2º é REJECTED/ALREADY_REVERSED e não credita', async () => {
    const { wallet, bet } = await walletWithBet();
    expect((await post(reversalPayload(wallet, bet, 'REFUND'))).status).toBe(201);
    rejected(await post(reversalPayload(wallet, bet, 'REFUND')), 'ALREADY_REVERSED');
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });

  test.each([['REFUND', 'ROLLBACK'], ['ROLLBACK', 'REFUND'], ['ROLLBACK', 'ROLLBACK']] as const)(
    '%s e depois %s da mesma BET: o 2º é ALREADY_REVERSED (reversão de qualquer tipo é única)',
    async (first, second) => {
      const { wallet, bet } = await walletWithBet();
      expect((await post(reversalPayload(wallet, bet, first))).status).toBe(201);
      rejected(await post(reversalPayload(wallet, bet, second)), 'ALREADY_REVERSED');
      expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    },
  );

  test('ROLLBACK duas vezes do mesmo REFUND: o 2º é ALREADY_REVERSED', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = reversalPayload(wallet, bet, 'REFUND');
    await post(refund);
    expect((await post(reversalPayload(wallet, refund, 'ROLLBACK'))).status).toBe(201);
    rejected(await post(reversalPayload(wallet, refund, 'ROLLBACK')), 'ALREADY_REVERSED');
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 4 });
  });

  test('reversão REJECTED não conta: depois de um REFUND com valor errado, o REFUND correto passa', async () => {
    const { wallet, bet } = await walletWithBet();
    rejected(await post(reversalPayload(wallet, bet, 'REFUND', { money: money('29.00') })), 'AMOUNT_MISMATCH');
    expect((await post(reversalPayload(wallet, bet, 'REFUND'))).status).toBe(201);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 3 });
  });
});

describe('regra 5: valor igual ao da referência', () => {
  test.each([['menor', '29.99'], ['maior', '30.01']])('valor %s: REJECTED/AMOUNT_MISMATCH, saldo e ledger intactos', async (_name, amount) => {
    const { wallet, bet } = await walletWithBet();
    rejected(await post(reversalPayload(wallet, bet, 'REFUND', { money: money(amount) })), 'AMOUNT_MISMATCH');
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });
});

describe('regra 6: REJECTED não altera saldo nem gera ledger; fica auditável', () => {
  test('transação REJECTED persiste failure_code e observed_balance, sem lançamento, wallet sem novo version', async () => {
    const { wallet, bet } = await walletWithBet();
    const res = await post(reversalPayload(wallet, bet, 'REFUND', { money: money('1.00') }));

    rejected(res, 'AMOUNT_MISMATCH');
    expect(res.body.balance).toEqual(money('70.00'));
    expect(await rows('select status, failure_code, observed_balance::text, processed_at from wager_transactions where id = $1', [res.body.transactionId])).toEqual([
      { status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH', observed_balance: '70.00', processed_at: null },
    ]);
    expect(await rows('select 1 from wallet_ledger_entries where transaction_id = $1', [res.body.transactionId])).toHaveLength(0);
    expect(await rows('select version from wallets where id = $1', [wallet.walletId])).toEqual([{ version: 2 }]);
  });
});

describe('regra 7: repetir devolve o resultado original', () => {
  test('replay de REFUND processado: mesmo 201 e corpo, com o saldo da época (não o atual)', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = reversalPayload(wallet, bet, 'REFUND');
    const first = await post(refund);
    await processed(wallet, 'WIN', '500.00');
    const replay = await post(refund);

    expect(first.body.balance).toEqual(money('100.00'));
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await state(wallet)).toEqual({ stored: '600.00', rebuilt: '600.00', entries: 4 });
  });

  test('replay de reversão REJECTED: mesmo 422 e mesmo failureCode, sem reprocessar (mesmo que agora fosse válida)', async () => {
    const { wallet, bet } = await walletWithBet();
    const early = reversalPayload(wallet, bet, 'ROLLBACK');
    expect((await post(reversalPayload(wallet, bet, 'REFUND'))).status).toBe(201);
    const first = await post(early);
    rejected(first, 'ALREADY_REVERSED');
    const replay = await post(early);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('mesma chave com outra referência: 409 IDEMPOTENCY_CONFLICT (a referência entra no payloadHash)', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = reversalPayload(wallet, bet, 'REFUND');
    await post(refund);
    const res = await submit(api, { ...refund, referenceExternalTransactionId: 'outra-referencia' }, defaultKey(refund));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('regra 8: referência ausente => PENDING_REFERENCE', () => {
  test('202 sem mexer no saldo nem no ledger; transação agendada para reprocesso', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-que-ainda-nao-chegou', money: money('30.00') });
    const res = await post(payload);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', balance: null, idempotentReplay: false });
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
    expect(await rows('select version from wallets where id = $1', [wallet.walletId])).toEqual([{ version: 1 }]);
    const [row] = await rows('select status, attempts, next_attempt_at is not null as scheduled, failure_code from wager_transactions where id = $1', [res.body.transactionId]);
    expect(row).toEqual({ status: 'PENDING_REFERENCE', attempts: 1, scheduled: true, failure_code: null });
  });

  test('replay de PENDING_REFERENCE devolve 202 e o mesmo corpo, sem reprocessar nem duplicar a linha', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'ainda-nao-chegou' });
    const first = await post(payload);
    const replay = await post(payload);

    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await rows('select attempts from wager_transactions where external_transaction_id = $1', [payload.externalTransactionId])).toEqual([{ attempts: 1 }]);
  });

  test('GET por id mostra PENDING_REFERENCE', async () => {
    const wallet = await openWallet(api, '100.00');
    const res = await post(wagerPayload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'x' }));
    const found = await api.call('GET', `/wagering/transactions/${res.body.transactionId}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null, balance: null, processedAt: null });
  });

  test('referência que existe mas ainda está PENDING_REFERENCE: a reversão também espera (202)', async () => {
    const wallet = await openWallet(api, '100.00');
    const winWaitingForBet = wagerPayload(wallet, { kind: 'WIN', referenceExternalTransactionId: 'bet-ausente', money: money('20.00') });
    expect((await post(winWaitingForBet)).status).toBe(202);
    const res = await post(reversalPayload(wallet, winWaitingForBet, 'ROLLBACK'));
    expect(res.status).toBe(202);
    expect(await state(wallet)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  });
});

describe('regra 9: reversão que deixaria saldo negativo', () => {
  test('ROLLBACK de WIN depois de gastar o prêmio: REJECTED/REVERSAL_WOULD_OVERDRAW (distinto de INSUFFICIENT_BALANCE), auditável, sem ledger', async () => {
    const wallet = await openWallet(api, '100.00');
    const win = (await processed(wallet, 'WIN', '50.00')).payload; // 150,00
    await processed(wallet, 'BET', '140.00'); // 10,00
    const rollback = reversalPayload(wallet, win, 'ROLLBACK');
    const res = await post(rollback);

    rejected(res, 'REVERSAL_WOULD_OVERDRAW');
    expect(res.body.failureCode).not.toBe('INSUFFICIENT_BALANCE');
    expect(res.body.balance).toEqual(money('10.00'));
    expect(await rows('select status, failure_code from wager_transactions where id = $1', [res.body.transactionId])).toEqual([
      { status: 'REJECTED', failure_code: 'REVERSAL_WOULD_OVERDRAW' },
    ]);
    expect(await state(wallet)).toEqual({ stored: '10.00', rebuilt: '10.00', entries: 3 });
    const replay = await post(rollback);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...res.body, idempotentReplay: true });
  });

  test('o mesmo saldo curto numa BET continua sendo INSUFFICIENT_BALANCE', async () => {
    const wallet = await openWallet(api, '10.00');
    rejected(await post(wagerPayload(wallet, { money: money('50.00') })), 'INSUFFICIENT_BALANCE');
  });

  test('reversão que estoura NUMERIC(19,2): REJECTED/BALANCE_LIMIT_EXCEEDED, nunca 500', async () => {
    const wallet = await openWallet(api, '99999999999999998.00');
    const bet = (await processed(wallet, 'BET', '5.00')).payload; // 99999999999999993.00
    await processed(wallet, 'WIN', '5.00'); // volta a 99999999999999998.00
    await processed(wallet, 'WIN', '1.00'); // 99999999999999999.00 (limite)
    const res = await post(reversalPayload(wallet, bet, 'REFUND')); // +5,00 estoura

    rejected(res, 'BALANCE_LIMIT_EXCEEDED');
    expect(await state(wallet)).toEqual({ stored: '99999999999999999.00', rebuilt: '99999999999999999.00', entries: 4 });
  });
});

describe('WIN e LOSS com referenceExternalTransactionId: aceito, validado como o REFUND e entra no payloadHash', () => {
  test('WIN que referencia a BET da rodada: 201 e referência gravada', async () => {
    const { wallet, bet, betId } = await walletWithBet();
    const res = await post(wagerPayload(wallet, { kind: 'WIN', money: money('80.00'), referenceExternalTransactionId: bet.externalTransactionId }));
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(money('150.00'));
    expect(await rows('select reference_transaction_id from wager_transactions where id = $1', [res.body.transactionId])).toEqual([{ reference_transaction_id: betId }]);
  });

  test('LOSS que referencia a BET: 201, sem lançamento', async () => {
    const { wallet, bet } = await walletWithBet();
    const res = await post(wagerPayload(wallet, { kind: 'LOSS', money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }));
    expect(res.status).toBe(201);
    expect(await state(wallet)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
  });

  test('WIN com referência ausente: 202 PENDING_REFERENCE; outra rodada: REFERENCE_MISMATCH; referência que não é BET: INVALID_REFERENCE_KIND', async () => {
    const { wallet, bet } = await walletWithBet();
    expect((await post(wagerPayload(wallet, { kind: 'WIN', referenceExternalTransactionId: 'ausente' }))).status).toBe(202);
    rejected(await post(wagerPayload(wallet, { kind: 'WIN', roundId: 'round-outra', referenceExternalTransactionId: bet.externalTransactionId })), 'REFERENCE_MISMATCH');
    const win = (await processed(wallet, 'WIN', '5.00')).payload;
    rejected(await post(wagerPayload(wallet, { kind: 'WIN', referenceExternalTransactionId: win.externalTransactionId })), 'INVALID_REFERENCE_KIND');
    expect(await state(wallet)).toEqual({ stored: '75.00', rebuilt: '75.00', entries: 3 });
  });

  test('mesma chave com referência diferente: 409', async () => {
    const { wallet, bet } = await walletWithBet();
    const win = wagerPayload(wallet, { kind: 'WIN', referenceExternalTransactionId: bet.externalTransactionId });
    await post(win);
    const res = await submit(api, { ...win, referenceExternalTransactionId: 'outra' }, defaultKey(win));
    expect(res.status).toBe(409);
  });
});
