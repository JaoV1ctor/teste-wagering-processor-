// `expectRejected`, a conferência usada pela suíte de segurança, contra um servidor que recusa o pedido e vaza o segredo DE PROPÓSITO.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createProbe, ensureSchema } from '../support/db';
import { expectRejected, type Reply, SECRET_CANARY } from '../support/security';

const probe = createProbe();
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const message = 'Valor inválido: "abc"';
    const debug = new URL(request.url).pathname === '/vaza' ? { debug: SECRET_CANARY } : {};
    return Response.json({ code: 'VALIDATION_ERROR', message: 'Requisição inválida', details: [{ path: 'amount', message }], ...debug }, { status: 400 });
  },
});

beforeAll(ensureSchema);
afterAll(async () => {
  await server.stop(true);
  await probe.end();
});

async function reply(path: string): Promise<Reply> {
  const response = await fetch(new URL(path, server.url));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

describe('expectRejected', () => {
  test('reprova a resposta que vaza o segredo, mesmo declarando um valor enviado que é pedaço dele', async () => {
    await expect(expectRejected(probe, [['vazamento', () => reply('/vaza'), 'sec']])).rejects.toThrow('string de conexão ou credencial');
  });

  test('controle negativo: a mesma resposta sem o segredo passa', async () => {
    expect(await expectRejected(probe, [['limpa', () => reply('/limpa'), 'abc']])).toContain('400×1');
  });
});
