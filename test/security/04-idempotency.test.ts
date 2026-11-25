// Idempotência sob abuso, com atenção a dois provedores: a Idempotency-Key vale dentro de cada provedor. Nenhum caso pode entregar a um
// provedor dado algum de outro, nem deixar que um atrapalhe a chave do outro.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { ledgerBalance } from '../support/db';
import { type Isolated, postJson, type Reply, securityCategory, send, snapshot, startIsolated, tally } from '../support/security';
import { openWallet, reversalPayload, wagerPayload, type WagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(4, 'Idempotência e separação entre provedores');
let env: Isolated;

beforeAll(async () => {
  env = await startIsolated();
});
afterAll(async () => {
  write();
  await env.close();
});

const submit = (payload: unknown, key: string): Promise<Reply> => postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': key });
const money = (amount: string) => ({ amount, currency: 'BRL' });

/** Provedor A com uma aposta aceita; todos os valores dela são marcas únicas, para procurar em qualquer resposta dada a B. */
async function victim() {
  const wallet = await openWallet(env.api, '7321.45');
  const payload = wagerPayload(wallet, {
    providerId: `alfa-${uuid()}`, externalTransactionId: `ext-secreto-${uuid()}`, roundId: `rodada-secreta-${uuid()}`, gameId: `jogo-secreto-${uuid()}`,
    money: money('123.45'),
  });
  const key = `${payload.providerId}:${payload.externalTransactionId}`;
  const reply = await submit(payload, key);
  expect(reply.status).toBe(201);
  const { transactionId } = JSON.parse(reply.text) as { transactionId: string };
  const secrets = [transactionId, wallet.walletId, wallet.playerId, payload.externalTransactionId, payload.roundId, payload.gameId, payload.providerId, '7198.00', '123.45'];
  return { wallet, payload, key, transactionId, secrets };
}

/** O que B recebeu não pode conter nada de A que B não tenha ele mesmo enviado. */
function expectNothingFrom(secrets: readonly string[], reply: Reply, sentByB: unknown = {}): void {
  const sent = JSON.stringify(sentByB);
  const leaked = secrets.filter((secret) => !sent.includes(secret) && (reply.text.includes(secret) || [...reply.headers.values()].some((value) => value.includes(secret))));
  expect(leaked).toEqual([]);
}

securityCase('Mesmo provedor, mesma chave, cada campo de negócio diferente', '409 IDEMPOTENCY_CONFLICT; banco inalterado', async () => {
  const { payload, key } = await victim();
  const other = await openWallet(env.api, '10.00');
  const changes: Partial<WagerPayload>[] = [
    { money: money('123.46') }, { money: { amount: '123.45', currency: 'USD' } }, { kind: 'WIN' }, { roundId: 'x' }, { gameId: 'x' }, { externalTransactionId: 'x' },
    { playerId: uuid() }, { walletId: other.walletId },
  ];
  const before = await snapshot(env.probe);
  const statuses: number[] = [];
  for (const change of changes) {
    const reply = await submit({ ...payload, ...change }, key);
    statuses.push(reply.status);
    expect(JSON.parse(reply.text)).toEqual({ code: 'IDEMPOTENCY_CONFLICT', message: expect.any(String) });
  }
  expect(statuses.every((status) => status === 409)).toBe(true);
  expect(await snapshot(env.probe)).toEqual(before);
  return `${statuses.length} variações: ${tally(statuses)}; banco inalterado`;
});

securityCase('PROVEDOR DIFERENTE usa a chave de outro, com a própria wallet', '201 com transação própria; nada do primeiro na resposta; saldo do primeiro inalterado', async () => {
  const a = await victim();
  const walletB = await openWallet(env.api, '50.00');
  const payload = wagerPayload(walletB, { providerId: `beta-${uuid()}`, money: money('1.00') });
  const before = await ledgerBalance(env.probe, a.wallet.walletId);

  const reply = await submit(payload, a.key);

  expect(reply.status).toBe(201);
  expect(JSON.parse(reply.text)).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: money('49.00'), idempotentReplay: false });
  expectNothingFrom(a.secrets, reply, payload);
  expect(await ledgerBalance(env.probe, a.wallet.walletId)).toEqual(before);
  const replayOfA = await submit(a.payload, a.key);
  expect(JSON.parse(replayOfA.text)).toMatchObject({ transactionId: a.transactionId, idempotentReplay: true });
  return '201, transação própria do segundo; saldo do primeiro inalterado e o replay dele continua o original';
});

securityCase('Provedor diferente copia chave e campos, trocando só o providerId', 'comportamento atual: nunca recebe o original, mas cria transação própria sobre a wallet citada (não há autenticação)', async () => {
  const a = await victim();
  const copied = { ...a.payload, providerId: `beta-${uuid()}` };
  const before = await ledgerBalance(env.probe, a.wallet.walletId);

  const reply = await submit(copied, a.key);

  expect(reply.status).toBe(201);
  const body = JSON.parse(reply.text) as { transactionId: string; idempotentReplay: boolean };
  expect(body.idempotentReplay).toBe(false);
  expect(body.transactionId).not.toBe(a.transactionId);
  expectNothingFrom(a.secrets, reply, copied);
  expect((await ledgerBalance(env.probe, a.wallet.walletId)).entries).toBe(before.entries + 1);
  return '201 sem o id nem o saldo do original; a wallet foi debitada de novo, em nome do segundo provedor';
}, 'limitação');

securityCase('Dois provedores usam a mesma chave ao mesmo tempo (20 rodadas)', 'os dois 201, cada um com a própria transação; nenhum dado cruzado', async () => {
  const statuses: number[] = [];
  for (let round = 0; round < 20; round += 1) {
    const wallets = [await openWallet(env.api, '10.00'), await openWallet(env.api, '10.00')];
    const key = `repartida-${uuid()}`;
    const payloads = wallets.map((wallet, i) => wagerPayload(wallet, { providerId: `p${i}-${uuid()}`, money: money('1.00') }));
    const replies = await Promise.all(payloads.map((payload) => submit(payload, key)));
    expect(replies.map((r) => r.status)).toEqual([201, 201]);
    const ids = replies.map((r) => (JSON.parse(r.text) as { transactionId: string }).transactionId);
    expect(ids[0]).not.toBe(ids[1]);
    for (const mine of [0, 1]) {
      const other = payloads[1 - mine]!;
      expectNothingFrom([ids[1 - mine]!, other.walletId, other.playerId, other.externalTransactionId, other.providerId], replies[mine]!, payloads[mine]);
    }
    statuses.push(...replies.map((r) => r.status));
  }
  return `${tally(statuses)} em 20 rodadas; nenhum dado cruzado`;
});

securityCase('Consulta por identidade do provedor é separada', '404 ao perguntar pelo id externo de outro sob o próprio providerId', async () => {
  const a = await victim();
  const reply = await send(env.api, 'GET', `/providers/beta-${uuid()}/wagering/transactions/${a.payload.externalTransactionId}`);
  expect(reply.status).toBe(404);
  expectNothingFrom(a.secrets, reply, a.payload.externalTransactionId);
  return '404 TRANSACTION_NOT_FOUND';
});

securityCase('Outro provedor tenta reverter a transação alheia citando o id externo', '202 pendente: a referência é resolvida dentro do próprio provedor; nada creditado', async () => {
  const a = await victim();
  const before = await ledgerBalance(env.probe, a.wallet.walletId);
  const attack = reversalPayload(a.wallet, a.payload, 'REFUND', { providerId: `beta-${uuid()}` });

  const reply = await submit(attack, `beta-${uuid()}`);

  expect(reply.status).toBe(202);
  expect(JSON.parse(reply.text)).toMatchObject({ status: 'PENDING_REFERENCE', balance: null });
  expectNothingFrom(a.secrets, reply, attack);
  expect(await ledgerBalance(env.probe, a.wallet.walletId)).toEqual(before);
  return '202 PENDING_REFERENCE, balance null; saldo do primeiro inalterado';
});

securityCase('Ocupação antecipada da chave: B grava antes a chave que A usaria', 'A é aceito normalmente: a chave de B não ocupa a de A', async () => {
  const [walletA, walletB] = [await openWallet(env.api, '10.00'), await openWallet(env.api, '10.00')];
  const payloadA = wagerPayload(walletA, { providerId: `alfa-${uuid()}`, money: money('1.00') });
  const recommended = `${payloadA.providerId}:${payloadA.externalTransactionId}`;

  const squat = await submit(wagerPayload(walletB, { providerId: `beta-${uuid()}`, money: money('1.00') }), recommended);
  const legit = await submit(payloadA, recommended);
  const retry = await submit(payloadA, recommended);

  expect([squat.status, legit.status, retry.status]).toEqual([201, 201, 201]);
  expect(JSON.parse(retry.text)).toEqual({ ...(JSON.parse(legit.text) as object), idempotentReplay: true });
  expect(await ledgerBalance(env.probe, walletA.walletId)).toMatchObject({ stored: '9.00', entries: 2 });
  return 'B: 201; A: 201 e depois replay do próprio resultado';
});

securityCase('Replay idêntico, por quem conhece a chave e todos os campos', 'comportamento atual: devolve o resultado, porque nada identifica quem chama', async () => {
  const a = await victim();
  const replay = await submit(a.payload, a.key);
  expect(replay.status).toBe(201);
  expect(JSON.parse(replay.text)).toMatchObject({ transactionId: a.transactionId, idempotentReplay: true });
  return 'sem autenticação, quem conhece o payload inteiro e a chave recebe o resultado como o próprio provedor';
}, 'limitação');
