// Ponto de extensão de autenticação (docs/ARCHITECTURE.md, "Autenticação"): guard global no-op e porta de identidade do provedor.
// Aplicação real sobre Postgres REAL; os espiões só observam (ou fazem recusar) o guard e a porta, nunca o banco.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { ForbiddenException } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../src/application/ports';
import { AuthGuard } from '../../src/interface/http/auth.guard';
import { PROVIDER_IDENTITY } from '../../src/interface/http/wagering.controller';
import { type Api, startApi } from '../support/app';
import { createProbe, ensureSchema, ledgerBalance } from '../support/db';
import { defaultKey, openWallet, submit, wagerPayload } from '../support/wager';

const probe = createProbe();
let api: Api;
let authenticate: ReturnType<typeof spyOn<AuthGuard, 'authenticate'>>;
let ensureCanActAs: ReturnType<typeof spyOn<ProviderIdentityPort, 'ensureCanActAs'>>;

beforeAll(async () => {
  await ensureSchema();
  api = await startApi();
});
afterEach(() => {
  authenticate?.mockRestore();
  ensureCanActAs?.mockRestore();
});
afterAll(async () => {
  await api.close();
  await probe.end();
});

function observe(): void {
  authenticate = spyOn(api.app.get(AuthGuard), 'authenticate');
  ensureCanActAs = spyOn(api.app.get<ProviderIdentityPort>(PROVIDER_IDENTITY), 'ensureCanActAs');
}

describe('comportamento inalterado com o adaptador padrão', () => {
  test.each([
    ['sem Authorization', undefined],
    ['com um Authorization qualquer, que é ignorado', 'Bearer nao-e-um-token'],
  ])('POST /wagering/transactions %s: 201, replay idêntico, 1 débito; guard e porta consultados', async (_name, authorization) => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
    observe();

    const first = await submit(api, payload, defaultKey(payload), headers);
    const replay = await submit(api, payload, defaultKey(payload), headers);

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: { amount: '70.00', currency: 'BRL' }, idempotentReplay: false });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '70.00', rebuilt: '70.00', entries: 2 });
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(ensureCanActAs.mock.calls).toEqual([
      [{ declaredProviderId: payload.providerId, authorization }],
      [{ declaredProviderId: payload.providerId, authorization }],
    ]);
  });

  test('payload inválido continua 400 e não chega à porta de identidade', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet, { kind: 'OPENING' });
    observe();

    const res = await submit(api, payload, defaultKey(payload));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(ensureCanActAs).not.toHaveBeenCalled();
  });
});

describe('guard global', () => {
  test('as demais rotas passam pela autenticação', async () => {
    const wallet = await openWallet(api, '10.00');
    observe();

    for (const path of [`/wallets/${wallet.walletId}`, `/wallets/${wallet.walletId}/ledger`, '/providers/provider-a/wagering/transactions/inexistente']) {
      await api.call('GET', path);
    }
    await api.call('POST', `/wallets/${wallet.walletId}/reconciliation`);

    expect(authenticate).toHaveBeenCalledTimes(4);
  });

  test('/health/live, /health/ready e /metrics são abertas: respondem sem passar pela autenticação, mesmo que ela recuse tudo', async () => {
    observe();
    authenticate.mockImplementation(() => false);

    expect((await api.call('GET', '/health/live')).status).toBe(200);
    expect((await api.call('GET', '/health/ready')).status).toBe(200);
    const metrics = await fetch(`${api.url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('wager_transactions_total');
    expect(authenticate).not.toHaveBeenCalled();
  });

  test('quando a autenticação recusa, a rota protegida responde 403 e nada é gravado', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    observe();
    authenticate.mockImplementation(() => false);

    const res = await submit(api, payload, defaultKey(payload));

    expect(res.status).toBe(403);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
    expect(ensureCanActAs).not.toHaveBeenCalled();
  });
});

describe('porta de identidade do provedor', () => {
  test('um adaptador que recusa o providerId impede o processamento: 403, sem transação nem débito', async () => {
    const wallet = await openWallet(api, '100.00');
    const payload = wagerPayload(wallet);
    observe();
    ensureCanActAs.mockImplementation(async () => {
      throw new ForbiddenException();
    });

    const res = await submit(api, payload, defaultKey(payload));

    expect(res.status).toBe(403);
    expect((await probe.query('select 1 from wager_transactions where idempotency_key = $1', [defaultKey(payload)])).rows).toEqual([]);
    expect(await ledgerBalance(probe, wallet.walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', entries: 1 });
  });
});
