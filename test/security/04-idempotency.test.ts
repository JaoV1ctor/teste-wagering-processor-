// Idempotência sob abuso, com atenção a dois provedores: a Idempotency-Key é única no serviço inteiro. Nenhum caso pode entregar a um
// provedor dado algum de outro.
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

securityCase('Mesma chave com cada campo de negócio diferente', '409 IDEMPOTENCY_CONFLICT; banco inalterado', async () => {
  const { payload, key } = await victim();
  const other = await openWallet(env.api, '10.00');
  const changes: Partial<WagerPayload>[] = [
    { money: money('123.46') }, { money: { amount: '123.45', currency: 'USD' } }, { kind: 'WIN' }, { roundId: 'x' }, { gameId: 'x' }, { externalTransactionId: 'x' },
    { playerId: uuid() }, { walletId: other.walletId }, { providerId: 'x' },
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

securityCase('PROVEDOR DIFERENTE usa a chave de outro, com a própria wallet', '409 sem resultado nem dado algum do primeiro; banco inalterado', async () => {
  const a = await victim();
  const walletB = await openWallet(env.api, '50.00');
  const payload = wagerPayload(walletB, { providerId: `beta-${uuid()}`, money: money('1.00') });
  const before = await snapshot(env.probe);

  const reply = await submit(payload, a.key);

  expect(reply.status).toBe(409);
  expect(JSON.parse(reply.text)).toEqual({ code: 'IDEMPOTENCY_CONFLICT', message: 'Conflito de idempotência: a chave ou a identidade do provedor já pertence a outro payload' });
  expectNothingFrom(a.secrets, reply, payload);
  expect(await snapshot(env.probe)).toEqual(before);
  return '409 com corpo fixo (code e message); nenhum dado do primeiro provedor; banco inalterado';
});

securityCase('Provedor diferente copia chave e campos, trocando só o providerId', '409 sem dado do primeiro: o providerId entra no hash', async () => {
  const a = await victim();
  const stolen = { ...a.payload, providerId: `beta-${uuid()}` };
  const before = await snapshot(env.probe);

  const reply = await submit(stolen, a.key);

  expect(reply.status).toBe(409);
  expectNothingFrom(a.secrets, reply, stolen);
  expect(reply.text).not.toContain('transactionId');
  expect(reply.text).not.toContain('balance');
  expect(await snapshot(env.probe)).toEqual(before);
  return '409; sem transactionId, saldo ou status do original';
});

securityCase('Dois provedores disputam a mesma chave ao mesmo tempo (20 rodadas)', 'um 201 e um 409; o 409 não traz dado do vencedor', async () => {
  const statuses: number[] = [];
  for (let round = 0; round < 20; round += 1) {
    const [walletA, walletB] = [await openWallet(env.api, '10.00'), await openWallet(env.api, '10.00')];
    const key = `disputada-${uuid()}`;
    const payloads = [walletA, walletB].map((wallet, i) => wagerPayload(wallet, { providerId: `p${i}-${uuid()}`, money: money('1.00') }));
    const replies = await Promise.all(payloads.map((payload) => submit(payload, key)));
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = replies.findIndex((r) => r.status === 409);
    const winner = payloads[1 - loser]!;
    expectNothingFrom([winner.walletId, winner.playerId, winner.externalTransactionId, winner.providerId], replies[loser]!, payloads[loser]);
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

securityCase('Ocupação antecipada da chave: B grava antes a chave que A usaria', 'comportamento atual: A recebe 409 de forma permanente (negação entre provedores)', async () => {
  const [walletA, walletB] = [await openWallet(env.api, '10.00'), await openWallet(env.api, '10.00')];
  const payloadA = wagerPayload(walletA, { providerId: `alfa-${uuid()}`, money: money('1.00') });
  const recommended = `${payloadA.providerId}:${payloadA.externalTransactionId}`;

  const squat = await submit(wagerPayload(walletB, { providerId: `beta-${uuid()}`, money: money('1.00') }), recommended);
  const legit = await submit(payloadA, recommended);
  const retry = await submit(payloadA, recommended);

  expect([squat.status, legit.status, retry.status]).toEqual([201, 409, 409]);
  expect(await ledgerBalance(env.probe, walletA.walletId)).toMatchObject({ stored: '10.00', entries: 1 });
  return 'B: 201; A com a chave recomendada: 409, 409; A só consegue com outra chave';
}, 'limitação');

securityCase('Replay idêntico, por quem conhece a chave e todos os campos', 'comportamento atual: devolve o resultado, porque nada identifica quem chama', async () => {
  const a = await victim();
  const replay = await submit(a.payload, a.key);
  expect(replay.status).toBe(201);
  expect(JSON.parse(replay.text)).toMatchObject({ transactionId: a.transactionId, idempotentReplay: true });
  return 'sem autenticação, quem conhece o payload inteiro e a chave recebe o resultado como o próprio provedor';
}, 'limitação');
