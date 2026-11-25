// Auto-teste do detector da suíte de segurança: respostas que vazam DE PROPÓSITO precisam ser apontadas, e respostas limpas não.
import { describe, expect, test } from 'bun:test';
import { toHttpError } from '../../src/interface/http/error-mapper';
import { CreateWalletBody } from '../../src/interface/http/wallets.dto';
import { leaksIn, leaksInReply, SECRET_CANARY } from '../support/leaks';

/** Corpo de erro de validação no formato da API, com o texto dado em `details[0].message`. */
const validation = (message: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Requisição inválida', details: [{ path: 'money', message }], ...extra });
const echo = (sent: string): string => `Valor inválido: "${sent}"`;

const SQL = 'select balance from wallets where id = $1';

describe('vazamento proposital é apontado', () => {
  test.each([
    ['segredo', `falha ao assinar com ${SECRET_CANARY}`, 'string de conexão ou credencial'],
    ['string de conexão', 'postgres://wager:wager@db:5432/wager', 'string de conexão ou credencial'],
    ['SQL', SQL, 'SQL'],
    ['erro do banco', 'duplicate key value violates unique constraint', 'erro do banco ou do driver'],
    ['stack trace sem nome de função', 'Error: boom\n    at /app/server.ts:10:5', 'stack trace'],
    ['caminho do servidor', 'C:\\app\\main.ts', 'caminho do servidor'],
  ])('%s', (_label, leaked, expected) => {
    expect(leaksInReply(JSON.stringify({ code: 'INTERNAL_ERROR', message: leaked }))).toContain(expected);
  });

  test('em texto que não é JSON', () => {
    expect(leaksInReply(`<pre>${SQL}</pre>`, 'x')).toContain('SQL');
  });

  test('segredo com a primeira letra escrita como escape unicode no JSON', () => {
    // 92 é a barra invertida: no JSON fica o escape de "s", que o texto cru não deixa reconhecer.
    const escaped = `{"message":"${String.fromCharCode(92)}u0073${SECRET_CANARY.slice(1)}"}`;
    expect(leaksInReply(escaped)).toContain('string de conexão ou credencial');
  });

  test('valor enviado curto não apaga os espaços de um SQL vazado em outro campo', () => {
    expect(leaksInReply(validation(echo(' '), { debug: SQL }), ' ')).toContain('SQL');
  });

  test('valor enviado que é pedaço do segredo não o esconde', () => {
    expect(leaksInReply(validation('Valor inválido', { debug: SECRET_CANARY }), 'sec')).toContain('string de conexão ou credencial');
  });

  // O `JSON.parse` fica só com a última das chaves repetidas: o que veio na primeira só existe no texto recebido.
  test.each([
    ['campo repetido', `{"code":"VALIDATION_ERROR","details":[],"debug":"${SECRET_CANARY}","debug":"ok"}`],
    ['message repetida no detalhe', `{"code":"VALIDATION_ERROR","details":[{"message":"${SECRET_CANARY}","message":"ok"}]}`],
    ['details repetido', `{"code":"VALIDATION_ERROR","details":[{"message":"${SECRET_CANARY}"}],"details":[]}`],
  ])('segredo escondido por chave JSON repetida: %s', (_label, text) => {
    expect(leaksInReply(text, 'x')).toContain('string de conexão ou credencial');
  });

  test('cópia da mensagem com eco sob chave repetida não é descontada junto', () => {
    const message = JSON.stringify(echo(SQL));
    const text = `{"code":"VALIDATION_ERROR","debug":${message},"debug":"ok","details":[{"message":${message}}]}`;
    expect(leaksInReply(text, SQL)).toContain('SQL');
  });

  test('o valor enviado repetido FORA de details[].message não é descontado', () => {
    const sent = 'select 1 from wallets';
    expect(leaksInReply(JSON.stringify({ code: 'INTERNAL_ERROR', message: `Erro na consulta: ${sent}` }), sent)).toContain('SQL');
    expect(leaksInReply(validation(echo(sent), { debug: sent }), sent)).toContain('SQL');
  });

  test('em details[].message, só o eco entre aspas é descontado', () => {
    expect(leaksInReply(validation(`${echo('from')} em ${SQL}`), 'from')).toContain('SQL');
  });
});

describe('controle negativo: resposta limpa não é apontada', () => {
  test.each([
    "'; DROP TABLE wallets;--", 'select 1 from wallets', 'postgres://wager:wager@db/wager', 'a"b\\c\nat x (', '', ' ',
  ])('eco da entrada na mensagem de validação: %j', (sent) => {
    expect(leaksInReply(validation(echo(sent)), sent)).toEqual([]);
  });

  test('o mesmo eco em dois detalhes', () => {
    const sent = "select 1 from wallets $& $'";
    const message = echo(sent);
    const text = JSON.stringify({ code: 'VALIDATION_ERROR', details: [{ message }, { message }] });
    expect(leaksInReply(text, sent)).toEqual([]);
  });

  test('o eco real da API (valor e moeda) é descontado; sem declarar o valor enviado, é apontado', () => {
    const sent = 'select 1 from wallets';
    for (const money of [{ amount: sent, currency: 'BRL' }, { amount: '1.00', currency: sent }]) {
      const parsed = CreateWalletBody.safeParse({ playerId: '00000000-0000-4000-8000-000000000001', initialBalance: money });
      const text = JSON.stringify(toHttpError(parsed.error).body);
      expect(leaksInReply(text, sent)).toEqual([]);
      expect(leaksInReply(text)).toContain('SQL');
    }
  });

  test('erros fixos da API', () => {
    for (const body of [toHttpError(new Error(SQL)).body, { code: 'WALLET_NOT_FOUND', message: 'Wallet não encontrada' }]) {
      expect(leaksInReply(JSON.stringify(body))).toEqual([]);
      expect(leaksIn(JSON.stringify(body))).toEqual([]);
    }
  });
});
