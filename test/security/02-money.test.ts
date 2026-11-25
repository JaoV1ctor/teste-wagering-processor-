// Abuso de valores monetários em POST /wagering/transactions e POST /wallets. Aplicação real, banco e filas isolados.
import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID as uuid } from 'node:crypto';
import { type Attempt, expectRejected, type Isolated, postJson, securityCategory, startIsolated, tally } from '../support/security';
import { ledgerBalance } from '../support/db';
import { openWallet, wagerPayload, type WagerPayload } from '../support/wager';

const { securityCase, write } = securityCategory(2, 'Abuso de valores monetários');
let env: Isolated;
let wallet: { walletId: string; playerId: string };

beforeAll(async () => {
  env = await startIsolated();
  wallet = await openWallet(env.api, '100.00');
});
afterAll(async () => {
  write();
  await env.close();
});

const submit = (payload: unknown) => postJson(env.api, '/wagering/transactions', payload, { 'idempotency-key': `key-${uuid()}` });
const createWallet = (initialBalance: unknown) => postJson(env.api, '/wallets', { playerId: uuid(), initialBalance });

/** Corpo montado à mão: `amount` vai como o texto cru (número, literal inválido), o que `JSON.stringify` não produziria. */
const rawAmount = (raw: string) => JSON.stringify(wagerPayload(wallet, { money: { amount: '__AMOUNT__', currency: 'BRL' } })).replace('"__AMOUNT__"', raw);

/** Cada valor, nas duas portas que recebem dinheiro: aposta (todos os tipos que movem saldo) e abertura de wallet. */
function everywhere(amounts: readonly string[]): Attempt[] {
  return amounts.flatMap((amount): Attempt[] => [
    ...(['BET', 'WIN', 'LOSS'] as const).map((kind): Attempt => [`${kind} ${amount}`, () => submit(wagerPayload(wallet, { kind, money: { amount, currency: 'BRL' } })), amount]),
    [`wallet ${amount}`, () => createWallet({ amount, currency: 'BRL' }), amount],
  ]);
}

const rejects = (amounts: readonly string[]) => () => expectRejected(env.probe, everywhere(amounts));

securityCase('Valores negativos', '400; saldo e banco inalterados', rejects(['-1.00', '-0.01', '-0', '-0.00', '-99999999999999999.99']));

securityCase('Zero em aposta (initialBalance zero é válido e tem caso próprio)', '400; saldo e banco inalterados', () =>
  expectRejected(env.probe, ['0', '0.0', '0.00', '00.00'].flatMap((amount) =>
    (['BET', 'WIN', 'LOSS'] as const).map((kind): Attempt => [`${kind} ${amount}`, () => submit(wagerPayload(wallet, { kind, money: { amount, currency: 'BRL' } }))]))));

securityCase('NaN, Infinity e notação exponencial ou outras bases', '400; saldo e banco inalterados', rejects([
  'NaN', 'nan', 'Infinity', '-Infinity', '1e3', '1E3', '1e-3', '1.0e2', '0x10', '0b1', '0o7',
]));

securityCase('Mais de 2 casas decimais', '400 antes de chegar ao banco (que arredondaria em silêncio)', rejects(['10.005', '0.001', '1.999', '100.0000', '0.0000000001']));

securityCase('Formatos disfarçados (espaços, separadores, sinais, dígitos não ASCII, byte nulo)', '400; saldo e banco inalterados', rejects([
  '', ' ', ' 10.00', '10.00 ', '10,00', '1_000.00', '1 000', '+10.00', '10.', '.10', '10..0', '１０.００', '١٠', '10.00\u0000', '10.00\n', "10.00'; --",
]));

securityCase('Valores enormes e acima de NUMERIC(19,2)', '400; saldo e banco inalterados', rejects([
  '100000000000000000.00', '99999999999999999999.99', '9'.repeat(400), `${'0'.repeat(30)}1.00`, `1${'0'.repeat(50_000)}`,
]));

securityCase('Número, nulo, booleano, objeto ou array no lugar da string', '400; saldo e banco inalterados', () =>
  expectRejected(env.probe, ['10', '10.5', '-1', '0', '1e309', '-1e309', '9007199254740993', 'null', 'true', '[]', '["10.00"]', '{}', '{"value":"10.00"}']
    .map((raw): Attempt => [raw, () => submit(rawAmount(raw))])));

securityCase('Literais NaN e Infinity sem aspas (JSON inválido)', '400; saldo e banco inalterados', () =>
  expectRejected(env.probe, ['NaN', 'Infinity', '-Infinity', '01', '1.'].map((raw): Attempt => [raw, () => submit(rawAmount(raw))])));

securityCase('Moeda fora do formato', '400; saldo e banco inalterados', () =>
  expectRejected(env.probe, ['brl', 'Brl', 'BR', 'BRLL', '', ' BRL', 'R$', '986', 'ВRL'].flatMap((currency): Attempt[] => [
    [`aposta ${currency}`, () => submit(wagerPayload(wallet, { money: { amount: '1.00', currency } })), currency],
    [`wallet ${currency}`, () => createWallet({ amount: '1.00', currency }), currency],
  ]).concat([['moeda numérica', () => submit(wagerPayload(wallet, { money: { amount: '1.00', currency: 986 as unknown as string } }))]])));

securityCase('Campos extras ou ausentes em money', '400; saldo e banco inalterados', () =>
  expectRejected(env.probe, [{ amount: '1.00' }, { currency: 'BRL' }, { amount: '1.00', currency: 'BRL', cents: 100 }, null, '1.00', []]
    .map((money): Attempt => [JSON.stringify(money), () => submit({ ...wagerPayload(wallet), money })])));

/** Valores no limite do tipo são válidos na forma: a regra de negócio rejeita, grava a rejeição e não move saldo. */
async function businessRejection(kind: WagerPayload['kind'], amount: string, currency: string, failureCode: string): Promise<string> {
  const before = await ledgerBalance(env.probe, wallet.walletId);
  const reply = await submit(wagerPayload(wallet, { kind, money: { amount, currency } }));
  expect(reply.status).toBe(422);
  expect(JSON.parse(reply.text)).toMatchObject({ status: 'REJECTED', failureCode });
  expect(await ledgerBalance(env.probe, wallet.walletId)).toEqual(before);
  return `422 ${failureCode}`;
}

securityCase('BET no valor máximo do tipo', '422 INSUFFICIENT_BALANCE; saldo inalterado', () =>
  businessRejection('BET', '99999999999999999.99', 'BRL', 'INSUFFICIENT_BALANCE'));

securityCase('WIN que estouraria o saldo máximo', '422 BALANCE_LIMIT_EXCEEDED, nunca 500; saldo inalterado', () =>
  businessRejection('WIN', '99999999999999999.99', 'BRL', 'BALANCE_LIMIT_EXCEEDED'));

securityCase('Moeda válida, porém diferente da wallet', '422 CURRENCY_MISMATCH; saldo inalterado', () =>
  businessRejection('WIN', '1.00', 'XXX', 'CURRENCY_MISMATCH'));

securityCase('initialBalance zero (valor válido)', '201 sem lançamento no ledger', async () => {
  const reply = await createWallet({ amount: '0.00', currency: 'BRL' });
  expect(reply.status).toBe(201);
  const { id } = JSON.parse(reply.text) as { id: string };
  expect(await ledgerBalance(env.probe, id)).toEqual({ stored: '0.00', rebuilt: '0', entries: 0 });
  return '201; 0 lançamentos';
});

securityCase('Chave "amount" duplicada no JSON', 'vale a última ocorrência (regra do JSON.parse); um só movimento', async () => {
  const body = JSON.stringify(wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } })).replace('"amount":"1.00"', '"amount":"1.00","amount":"2.00"');
  const before = await ledgerBalance(env.probe, wallet.walletId);
  const reply = await submit(body);
  expect(reply.status).toBe(201);
  const after = await ledgerBalance(env.probe, wallet.walletId);
  expect(after.entries).toBe(before.entries + 1);
  const { rows } = await env.probe.query('select amount::text from wallet_ledger_entries where wallet_id = $1 order by seq desc limit 1', [wallet.walletId]);
  expect(rows).toEqual([{ amount: '2.00' }]);
  return `${tally([reply.status])}; debitado o último valor (2.00); chaves duplicadas não são recusadas`;
}, 'limitação');
