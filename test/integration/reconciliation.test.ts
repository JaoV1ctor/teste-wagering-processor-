// POST /wallets/:walletId/reconciliation (SPEC §5.3, §8.4; README §9). Postgres REAL, aplicação real.
// A divergência é provocada por SQL direto (trigger desligado só dentro de uma transação do teste) e tem de ser DETECTADA e NÃO corrigida.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Api, startApi } from '../support/app';
import { createProbe, creditLedgerOnly, ensureSchema, healFromLedger, inflateBalance, ledgerBalance } from '../support/db';
import { type LogCapture, captureLogs } from '../support/logs';
import { scrape, total } from '../support/metrics';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

const probe = createProbe();
let api: Api;
let capture: LogCapture | undefined;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await probe.end();
});
afterEach(() => capture?.restore());

const reconcile = (walletId: string, headers: Record<string, string> = {}) => api.call('POST', `/wallets/${walletId}/reconciliation`, undefined, headers);
const money = (amount: string) => ({ amount, currency: 'BRL' });
const divergences = async () => total(await scrape(api), 'wager_reconciliation_divergence_total');

describe('wallet consistente', () => {
  test('saldo == soma do ledger: 200, consistent true, difference 0.00 e checkedEntries = lançamentos', async () => {
    const wallet = await openWallet(api, '100.00');
    const bet = wagerPayload(wallet, { money: money('30.00') });
    expect((await submit(api, bet, defaultKey(bet))).status).toBe(201);

    const before = await divergences();
    const res = await reconcile(wallet.walletId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.walletId, storedBalance: money('70.00'), calculatedBalance: money('70.00'), difference: money('0.00'), consistent: true, checkedEntries: 2,
    });
    expect(await divergences()).toBe(before);
    const balance = await ledgerBalance(probe, wallet.walletId);
    expect(balance.stored).toBe(balance.rebuilt);
  });

  test('wallet sem lançamentos (saldo inicial 0.00): consistente, 0 lançamentos', async () => {
    const wallet = await openWallet(api, '0.00');
    const res = await reconcile(wallet.walletId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.walletId, storedBalance: money('0.00'), calculatedBalance: money('0.00'), difference: money('0.00'), consistent: true, checkedEntries: 0,
    });
  });

  test('a reconciliação só lê: não muda saldo, version, ledger nem cria evento', async () => {
    const wallet = await openWallet(api, '50.00');
    const read = async () =>
      (await probe.query(
        `select (select balance::text from wallets where id = $1::uuid) b, (select version from wallets where id = $1::uuid) v,
                (select count(*) from wallet_ledger_entries where wallet_id = $1::uuid)::int l,
                (select count(*) from outbox_messages where payload->'data'->>'walletId' = $1::text)::int o`, [wallet.walletId])).rows[0];
    const before = await read();
    await reconcile(wallet.walletId);
    expect(await read()).toEqual(before);
  });
});

describe('erros de entrada', () => {
  test('wallet inexistente: 404 WALLET_NOT_FOUND', async () => {
    const res = await reconcile(uuid());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('walletId que não é UUID: 400 VALIDATION_ERROR', async () => {
    const res = await reconcile('nao-e-um-uuid');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('divergência provocada: detectada, sinalizada, logada, contada e NÃO corrigida', () => {
  test('saldo MAIOR que o ledger (saldo alterado por SQL direto, sem lançamento)', async () => {
    const wallet = await openWallet(api, '100.00');
    await inflateBalance(probe, wallet.walletId, '5.00');
    try {
      const countBefore = await divergences();
      capture = captureLogs();
      const first = await reconcile(wallet.walletId, { 'x-correlation-id': 'corr-recon-1' });
      capture.restore();

      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        walletId: wallet.walletId, storedBalance: money('105.00'), calculatedBalance: money('100.00'), difference: money('5.00'), consistent: false, checkedEntries: 1,
      });
      expect(await divergences()).toBe(countBefore + 1);
      expect(capture.named('wallet_reconciliation_diverged')).toEqual([
        expect.objectContaining({ level: 'error', walletId: wallet.walletId, correlationId: 'corr-recon-1', checkedEntries: 1, difference: '5.00' }),
      ]);

      // NÃO corrigiu: o saldo continua o adulterado e o ledger intacto; uma 2ª reconciliação vê a mesma divergência (e conta de novo).
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '105.00', rebuilt: '100.00', entries: 1 });
      const second = await reconcile(wallet.walletId);
      expect(second.body).toEqual(first.body);
      expect(await divergences()).toBe(countBefore + 2);
    } finally {
      await healFromLedger(probe, wallet.walletId);
    }
  });

  test('ledger MAIOR que o saldo (lançamento gravado sem atualizar a wallet): diferença negativa', async () => {
    const wallet = await openWallet(api, '100.00');
    await creditLedgerOnly(probe, wallet.walletId, '7.50');
    try {
      const countBefore = await divergences();
      const res = await reconcile(wallet.walletId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId: wallet.walletId, storedBalance: money('100.00'), calculatedBalance: money('107.50'), difference: money('-7.50'), consistent: false, checkedEntries: 2,
      });
      expect(await divergences()).toBe(countBefore + 1);
      expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '107.50', entries: 2 });
    } finally {
      await healFromLedger(probe, wallet.walletId);
    }
  });

  test('realinhada por um UPDATE legítimo, a wallet volta a ser consistente (o teste não deixa lixo no banco compartilhado)', async () => {
    const wallet = await openWallet(api, '10.00');
    await inflateBalance(probe, wallet.walletId, '1.00');
    expect((await reconcile(wallet.walletId)).body.consistent).toBe(false);
    await healFromLedger(probe, wallet.walletId);
    expect((await reconcile(wallet.walletId)).body).toMatchObject({ consistent: true, difference: money('0.00') });
  });
});
