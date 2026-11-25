// Mensagens venenosas na fila de entrada, com o consumidor REAL da aplicação. Cada veneno vai no MESMO grupo de uma mensagem válida
// enviada logo depois: a prova de saúde é a válida ser processada.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { buildWagerMessage } from '../../scripts/send-wager-message';
import { QueueConsumer } from '../../src/interface/sqs/queue-consumer';
import type { WagerTransactionRequested } from '../../src/interface/sqs/wager-transaction-message';
import { ledgerBalance } from '../support/db';
import { captureLogs } from '../support/logs';
import { type Isolated, securityCategory, snapshot, startIsolated, tally } from '../support/security';
import { isQueueEmpty, sendRaw, waitFor } from '../support/sqs';
import { openWallet } from '../support/wager';

const { securityCase, write } = securityCategory(8, 'Mensagens SQS venenosas');
let env: Isolated;
let wallet: { walletId: string; playerId: string };

beforeAll(async () => {
  env = await startIsolated();
  wallet = await openWallet(env.api, '1000.00');
  env.api.app.get(QueueConsumer).start();
});
afterAll(async () => {
  write();
  await env.close();
});

const message = (overrides: Record<string, string> = {}): WagerTransactionRequested =>
  buildWagerMessage({
    providerId: 'provider-a', playerId: wallet.playerId, walletId: wallet.walletId, roundId: 'r', gameId: 'g', kind: 'BET', amount: '1.00', currency: 'BRL', ...overrides,
  });
const send = (body: string) => sendRaw(env.sqs, env.queues.mainUrl, body, { groupId: wallet.walletId });

/** Retira a próxima mensagem da DLQ (e a apaga): corpo e motivo. */
async function takeDeadLetter(): Promise<{ body: string; reason: string | undefined }> {
  let found: { body: string; reason: string | undefined } | undefined;
  await waitFor('mensagem na DLQ', async () => {
    const { Messages } = await env.sqs.send(new ReceiveMessageCommand({
      QueueUrl: env.queues.dlqUrl, MaxNumberOfMessages: 1, MessageAttributeNames: ['All'], WaitTimeSeconds: 0,
    }));
    const [received] = Messages ?? [];
    if (!received) return false;
    await env.sqs.send(new DeleteMessageCommand({ QueueUrl: env.queues.dlqUrl, ReceiptHandle: received.ReceiptHandle! }));
    found = { body: received.Body ?? '', reason: received.MessageAttributes?.['FailureReason']?.StringValue };
    return true;
  });
  return found!;
}

/** Envia uma aposta válida e espera ela ser aplicada: consumidor vivo e grupo desbloqueado. */
async function healthy(): Promise<void> {
  const next = message();
  const before = await ledgerBalance(env.probe, wallet.walletId);
  await send(JSON.stringify(next));
  await waitFor('mensagem válida seguinte processada', async () => (await ledgerBalance(env.probe, wallet.walletId)).entries === before.entries + 1);
  await waitFor('fila de entrada vazia', () => isQueueEmpty(env.sqs, env.queues.mainUrl));
}

/** Cada veneno vai à DLQ com o motivo esperado, sem escrever nada, e a mensagem seguinte é processada. */
async function poison(cases: readonly (readonly [label: string, body: string, reason: string])[]): Promise<string> {
  const reasons: string[] = [];
  for (const [label, body, reason] of cases) {
    const before = await snapshot(env.probe);
    await send(body);
    const dead = await takeDeadLetter();
    expect([label, dead.reason]).toEqual([label, reason]);
    expect(dead.body).toBe(body);
    expect(await snapshot(env.probe)).toEqual(before);
    reasons.push(reason);
    await healthy();
  }
  expect(await isQueueEmpty(env.sqs, env.queues.dlqUrl)).toBe(true);
  return `${cases.length} veneno(s) na DLQ (${tally(reasons)}), sem escrita; a mensagem válida seguinte foi sempre processada`;
}

const withData = (data: Record<string, unknown>) => {
  const base = message();
  return JSON.stringify({ ...base, data: { ...base.data, ...data } });
};
const withEnvelope = (change: Record<string, unknown>) => JSON.stringify({ ...message(), ...change });

securityCase('Corpo que não é um envelope JSON', 'DLQ MALFORMED_MESSAGE; consumidor segue', () =>
  poison([
    ['texto', 'isto não é json'], ['truncado', '{"messageId":'], ['array', '[1,2,3]'], ['string', '"abc"'], ['número', '42'], ['null', 'null'], ['objeto vazio', '{}'],
    ['XML', '<message/>'], ['muito aninhado', `${'['.repeat(100_000)}${']'.repeat(100_000)}`],
  ].map(([label, body]) => [label!, body!, 'MALFORMED_MESSAGE'] as const)));

securityCase('Campos faltando ou com tipo errado', 'DLQ MALFORMED_MESSAGE; consumidor segue', () =>
  poison([
    ['sem messageId', withEnvelope({ messageId: undefined })], ['sem type', withEnvelope({ type: undefined })], ['sem occurredAt', withEnvelope({ occurredAt: undefined })],
    ['occurredAt inválido', withEnvelope({ occurredAt: 'ontem' })], ['sem data', withEnvelope({ data: undefined })], ['data array', withEnvelope({ data: [] })],
    ['messageId numérico', withEnvelope({ messageId: 7 })], ['sem walletId', withData({ walletId: undefined })], ['walletId inválido', withData({ walletId: "x'; --" })],
    ['sem idempotencyKey', withData({ idempotencyKey: undefined })], ['kind OPENING', withData({ kind: 'OPENING' })], ['campo extra', withData({ admin: true })],
    ['campo extra no envelope', withEnvelope({ priority: 9 })], ['__proto__', withData({}).replace('"data":{', '"data":{"__proto__":{"polluted":1},')],
    ['messageId de 129', withEnvelope({ messageId: 'm'.repeat(129) })], ['providerId de 256', withData({ providerId: 'p'.repeat(256) })],
  ].map(([label, body]) => [label!, body!, 'MALFORMED_MESSAGE'] as const)));

securityCase('Byte nulo e surrogate solto em campos de texto da mensagem', 'DLQ MALFORMED_MESSAGE, enviada pelo próprio consumidor (com FailureReason); nada gravado', () =>
  poison([
    ['messageId nulo', withEnvelope({ messageId: `m\u0000-${uuid()}` })], ['providerId nulo', withData({ providerId: 'p\u0000' })],
    ['roundId nulo', withData({ roundId: 'r\u0000' })], ['chave nula', withData({ idempotencyKey: `k\u0000-${uuid()}` })],
    ['chave com surrogate', withData({ idempotencyKey: `k\uD800-${uuid()}`, externalTransactionId: `e-${uuid()}` })],
    ['messageId com surrogate', withEnvelope({ messageId: `m\uDC00-${uuid()}` })],
  ].map(([label, body]) => [label!, body!, 'MALFORMED_MESSAGE'] as const)));

securityCase('Dinheiro abusivo na mensagem', 'DLQ MALFORMED_MESSAGE; saldo inalterado', () =>
  poison([10, '-1.00', '0.00', 'NaN', 'Infinity', '1e3', '10.005', '99999999999999999999.99'].map((amount) =>
    [String(amount), withData({ money: { amount, currency: 'BRL' } }), 'MALFORMED_MESSAGE'] as const)));

securityCase('Tipo de mensagem desconhecido', 'DLQ UNKNOWN_MESSAGE_TYPE', () =>
  poison([['outro tipo', withEnvelope({ type: 'DropAllWallets' }), 'UNKNOWN_MESSAGE_TYPE']]));

securityCase('Wallet inexistente', 'DLQ WALLET_NOT_FOUND, nada gravado', () =>
  poison([['wallet aleatória', withData({ walletId: uuid() }), 'WALLET_NOT_FOUND']]));

securityCase('Mensagem enorme dentro do limite do broker (200 KB)', 'DLQ MALFORMED_MESSAGE', () =>
  poison([['campo de 200 KB', withData({ gameId: 'g'.repeat(200_000) }), 'MALFORMED_MESSAGE']]));

securityCase('Mensagem acima do limite do SQS (2 MB)', 'recusada pelo broker, ou entregue e enviada à DLQ; consumidor segue', async () => {
  const body = withData({ gameId: 'g'.repeat(2_000_000) });
  let broker: string;
  try {
    await send(body);
    const dead = await takeDeadLetter();
    expect(dead.reason).toBe('MALFORMED_MESSAGE');
    broker = 'o MiniStack aceitou; o consumidor mandou à DLQ';
  } catch (error) {
    expect((error as Error).message).toMatch(/long|size|large|bytes|length/i);
    broker = 'recusada pelo broker no envio';
  }
  await healthy();
  return `${broker}; a válida seguinte foi processada`;
});

securityCase('messageId repetido com conteúdo diferente', 'DLQ INBOX_PAYLOAD_CONFLICT; só o primeiro conteúdo é aplicado', async () => {
  const first = message();
  const before = await ledgerBalance(env.probe, wallet.walletId);
  await send(JSON.stringify(first));
  await waitFor('primeira aplicada', async () => (await ledgerBalance(env.probe, wallet.walletId)).entries === before.entries + 1);
  const forged = { ...first, data: { ...first.data, externalTransactionId: `forjada-${uuid()}`, idempotencyKey: `forjada-${uuid()}`, money: { amount: '500.00', currency: 'BRL' } } };
  return poison([['mesmo messageId', JSON.stringify(forged), 'INBOX_PAYLOAD_CONFLICT']]);
});

securityCase('Outro provedor reutiliza pela fila a chave de um primeiro', 'as duas aplicadas, cada uma no próprio provedor; nada na DLQ', async () => {
  const first = message({ providerId: 'alfa' });
  const other = message({ providerId: 'beta', idempotencyKey: first.data.idempotencyKey });
  const before = await ledgerBalance(env.probe, wallet.walletId);
  await send(JSON.stringify(first));
  await send(JSON.stringify(other));
  await waitFor('as duas aplicadas', async () => (await ledgerBalance(env.probe, wallet.walletId)).entries === before.entries + 2);
  await waitFor('fila de entrada vazia', () => isQueueEmpty(env.sqs, env.queues.mainUrl));
  expect(await isQueueEmpty(env.sqs, env.queues.dlqUrl)).toBe(true);
  return '2 lançamentos, DLQ vazia';
});

securityCase('Outro provedor ocupa antes o messageId de um primeiro', 'comportamento atual: a messageId vale para o consumidor inteiro; a mensagem legítima vai à DLQ', async () => {
  const messageId = `compartilhada-${uuid()}`;
  const squatter = message({ providerId: 'beta', messageId });
  const legit = message({ providerId: 'alfa', messageId });
  const before = await ledgerBalance(env.probe, wallet.walletId);
  await send(JSON.stringify(squatter));
  await waitFor('a primeira aplicada', async () => (await ledgerBalance(env.probe, wallet.walletId)).entries === before.entries + 1);
  // Outro MessageDeduplicationId: como se o broker já não deduplicasse (a janela dele é de 5 minutos).
  const summary = await poison([['messageId alheio', JSON.stringify(legit), 'INBOX_PAYLOAD_CONFLICT']]);
  expect((await env.probe.query('select 1 from wager_transactions where external_transaction_id = $1', [legit.data.externalTransactionId])).rows).toEqual([]);
  return `a legítima não foi aplicada: ${summary}`;
}, 'limitação');

securityCase('Logs do consumidor durante os venenos', 'uma linha JSON por evento, sem o corpo da mensagem', async () => {
  const marker = `marca-fila-${uuid()}`;
  const logs = captureLogs();
  let lines: string[];
  try {
    await poison([['com marca', withData({ gameId: marker, money: { amount: '4321.091', currency: 'BRL' } }), 'MALFORMED_MESSAGE'],
      ['tipo com marca', withEnvelope({ type: marker }), 'UNKNOWN_MESSAGE_TYPE']]);
    lines = logs.lines().map((line) => line.raw);
  } finally {
    logs.restore();
  }
  expect(lines.join('\n')).not.toContain(marker);
  expect(lines.join('\n')).not.toContain('4321.091');
  return `${lines.length} linhas de log, sem a marca nem o valor`;
});

securityCase('A fila de entrada não é autenticada', 'comportamento atual: quem consegue publicar na fila move qualquer wallet', async () => {
  const before = await ledgerBalance(env.probe, wallet.walletId);
  await send(JSON.stringify(message({ providerId: `qualquer-${uuid()}`, kind: 'WIN', amount: '1.00' })));
  await waitFor('crédito aplicado', async () => (await ledgerBalance(env.probe, wallet.walletId)).entries === before.entries + 1);
  return 'WIN de um providerId desconhecido foi creditado; a proteção depende da política da fila';
}, 'limitação');
