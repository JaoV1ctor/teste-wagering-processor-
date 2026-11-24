import { DriverException } from '@mikro-orm/core';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * ÚNICO ponto de saída de log da aplicação (SPEC §8.4): uma linha JSON por chamada, em stdout (info, warn) ou stderr (error).
 * Nada mais escreve em stdout/stderr (a regra `no-console` do ESLint barra `console.*` e o logger do Nest passa por aqui: ver `JsonLogger`).
 * Quem chama passa só identificadores (correlationId, messageId, transactionId, walletId, providerId) e o resultado; nunca payload, valor ou segredo.
 */
export function logJson(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ level, time: new Date().toISOString(), message, ...fields })}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
}

/** `type` e não `interface`: precisa caber em `Record<string, unknown>` (os campos do log) sem assinatura de índice. */
export type ErrorDescription = {
  errorName: string;
  errorMessage?: string;
  errorCode?: string;
  causeName?: string;
  causeCode?: string;
};

const stringCode = (error: object): string | undefined => ('code' in error && typeof error.code === 'string' ? error.code : undefined);

/**
 * Nome, mensagem e código do erro, sem vazar dado da requisição: a mensagem de um erro do driver (ou de rede) pode trazer o SQL com os
 * valores (`insert into ... values ('<playerId>', 777.77)`), então erro com `code` (SQLSTATE, `ECONNREFUSED`) ou do driver loga só nome e código.
 * Os erros que nós mesmos lançamos têm mensagem escrita por nós (ids, nunca valores) e a mantêm. A causa (um nível) entra só com nome e código.
 * Valor que não é `Error` (alguém lançou uma string ou um objeto) loga só o tipo.
 */
export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = stringCode(error);
  const fromDriver = code !== undefined || error instanceof DriverException;
  const described: ErrorDescription = { errorName: error.name };
  if (code !== undefined) described.errorCode = code;
  if (!fromDriver) described.errorMessage = error.message;
  if (error.cause instanceof Error) {
    described.causeName = error.cause.name;
    const causeCode = stringCode(error.cause);
    if (causeCode !== undefined) described.causeCode = causeCode;
  }
  return described;
}
