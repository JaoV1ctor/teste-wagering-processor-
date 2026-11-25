import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

/** Prova que a regra de lint barra `number` para dinheiro em `src/` (falha eliminatória no enunciado). */
const eslint = new ESLint({ cwd: process.cwd() });

async function messages(code: string, filePath = 'src/domain/fixture.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.message);
}

describe('regra de lint: dinheiro nunca é number', () => {
  test.each([
    ['parseFloat', 'export const a = parseFloat("1.5");'],
    ['Number.parseFloat', 'export const a = Number.parseFloat("1.5");'],
    ['Number()', 'export const a = Number("1.5");'],
    ['unário +', 'export const a = +"1.5";'],
    ['Math.round', 'export const a = Math.round(1.005 * 100);'],
    ['propriedade amount: number', 'export interface X { amount: number }'],
    ['propriedade balance: number', 'export class X { balance: number = 0; }'],
    ['parâmetro priceCents: number', 'export function f(priceCents: number) { return priceCents; }'],
    ['variável totalMoney: number', 'export const totalMoney: number = 1;'],
  ])('bloqueia %s', async (_name, code) => {
    const found = await messages(code);
    expect(found.some((m) => m.includes('dinheiro'))).toBe(true);
  });

  test.each([
    ['bigint em centavos', 'export const amountCents: bigint = 100n;'],
    ['string decimal', 'export interface X { amount: string }'],
    ['number para contagem', 'export interface X { version: number; limit: number }'],
    ['parseInt para paginação', 'export const limit = parseInt("50", 10);'],
  ])('permite %s', async (_name, code) => {
    expect((await messages(code)).filter((m) => m.includes('dinheiro'))).toEqual([]);
  });

  test('testes ficam fora da regra', async () => {
    expect((await messages('export const a = Number("1");', 'test/unit/fixture.test.ts')).filter((m) => m.includes('dinheiro'))).toEqual([]);
  });
});
