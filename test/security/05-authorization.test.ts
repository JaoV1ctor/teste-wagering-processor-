// Autorização. HOJE NÃO HÁ AUTENTICAÇÃO: os casos de limitação fixam esse comportamento; os de controle provam, com um adaptador que
// nega, que o caminho 403 funciona nos dois pontos de extensão.
import { afterAll, afterEach, beforeAll, expect, spyOn } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../src/application/ports';
import { AuthGuard } from '../../src/interface/http/auth.guard';
import { PROVIDER_IDENTITY } from '../../src/interface/http/wagering.controller';
import { type Isolated, postJson, securityCategory, send, snapshot, startIsolated, tally } from '../support/security';
import { openWallet, wagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(5, 'Autorização');
let env: Isolated;
let wallet: { walletId: string; playerId: string };
let payload: ReturnType<typeof wagerPayload>;
let transactionId: string;
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  env = await startIsolated();
  wallet = await openWallet(env.api, '100.00');
  payload = wagerPayload(wallet, { providerId: 'alfa' });
  const reply = await postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': 'auth-1' });
  transactionId = (JSON.parse(reply.text) as { transactionId: string }).transactionId;
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(async () => {
  write();
  await env.close();
});

/** Adaptador de teste: nega qualquer chamador. */
class DenyingProviderIdentity implements ProviderIdentityPort {
  async ensureCanActAs(): Promise<void> {
    throw new ForbiddenException();
  }
}

function denyAtThePort(): void {
  const adapter = env.api.app.get<ProviderIdentityPort>(PROVIDER_IDENTITY);
  const denying = new DenyingProviderIdentity();
  spies.push(spyOn(adapter, 'ensureCanActAs').mockImplementation(() => denying.ensureCanActAs()));
}
const denyAtTheGuard = (): void => void spies.push(spyOn(env.api.app.get(AuthGuard), 'authenticate').mockImplementation(() => false));

const reads = () => [
  `/wallets/${wallet.walletId}`, `/wallets/${wallet.walletId}/ledger`, `/wagering/transactions/${transactionId}`,
  `/providers/alfa/wagering/transactions/${payload.externalTransactionId}`,
];
const statusesOf = async (headers: Record<string, string> = {}) => {
  const statuses: number[] = [];
  for (const path of reads()) statuses.push((await send(env.api, 'GET', path, undefined, headers)).status);
  statuses.push((await send(env.api, 'POST', `/wallets/${wallet.walletId}/reconciliation`, undefined, headers)).status);
  return statuses;
};

securityCase('Qualquer chamador lê wallet, ledger e transação alheios pelo id', 'comportamento atual: 200 sem credencial alguma', async () => {
  const statuses = await statusesOf();
  expect(statuses).toEqual([200, 200, 200, 200, 200]);
  return `sem Authorization: ${tally(statuses)}`;
}, 'limitação');

securityCase('Credenciais forjadas não são verificadas', 'comportamento atual: ignoradas, 200', async () => {
  const statuses = [
    ...(await statusesOf({ authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJwcm92aWRlcl9pZCI6ImJldGEifQ.' })),
    ...(await statusesOf({ authorization: 'Basic YWRtaW46YWRtaW4=', 'x-provider-id': 'beta' })),
  ];
  expect(statuses.every((status) => status === 200)).toBe(true);
  return tally(statuses);
}, 'limitação');

securityCase('Qualquer chamador envia transação em nome de qualquer provedor e wallet', 'comportamento atual: 201', async () => {
  const reply = await postJson(env.api, '/wagering/transactions', wagerPayload(wallet, { providerId: 'alfa', money: { amount: '1.00', currency: 'BRL' } }), { 'idempotency-key': `k-${uuid()}` });
  expect(reply.status).toBe(201);
  return '201: o providerId do corpo é aceito como declarado';
}, 'limitação');

securityCase('Porta de identidade que nega: submissão', '403 antes de qualquer efeito; banco inalterado', async () => {
  denyAtThePort();
  const before = await snapshot(env.probe);
  const statuses: number[] = [];
  for (const key of [`k-${uuid()}`, 'auth-1']) statuses.push((await postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': key })).status);
  expect(statuses).toEqual([403, 403]);
  expect(await snapshot(env.probe)).toEqual(before);
  return `envio novo e replay: ${tally(statuses)}; banco inalterado`;
});

securityCase('Guard que nega: todas as rotas protegidas', '403; banco inalterado; health e metrics continuam abertos', async () => {
  denyAtTheGuard();
  const before = await snapshot(env.probe);
  const statuses = [
    ...(await statusesOf()),
    (await postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': `k-${uuid()}` })).status,
    (await postJson(env.api, '/wallets', { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } })).status,
  ];
  expect(statuses.every((status) => status === 403)).toBe(true);
  expect(await snapshot(env.probe)).toEqual(before);
  const open: number[] = [];
  for (const path of ['/health/live', '/health/ready']) open.push((await send(env.api, 'GET', path)).status);
  open.push((await fetch(`${env.api.url}/metrics`)).status);
  expect(open).toEqual([200, 200, 200]);
  return `protegidas: ${tally(statuses)}; abertas: ${tally(open)}`;
});

securityCase('A porta de identidade não cobre as consultas', 'comportamento atual: com a porta negando, as consultas respondem 200', async () => {
  denyAtThePort();
  const statuses = await statusesOf();
  expect(statuses.every((status) => status === 200)).toBe(true);
  return `porta negando: consultas ${tally(statuses)} (só o POST de transação a consulta)`;
}, 'limitação');
