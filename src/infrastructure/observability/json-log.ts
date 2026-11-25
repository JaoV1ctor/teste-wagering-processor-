import {
  IdempotencyConflictError, InboxPayloadConflictError, InvalidCursorError, TransientInfrastructureError, WagerTransactionNotFoundError,
  WalletAlreadyExistsError, WalletNotFoundError,
} from '../../application/errors';
import {
  InsufficientBalanceError, InvalidInboxMessageError, InvalidIntegrationEventError, InvalidOutboxMessageError, InvalidTransactionStateError,
  InvalidWagerTransactionError, LedgerEntryNotBalancedError, MoneyOverflowError,
} from '../../domain/errors';
import { ConfigurationError } from '../env';

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
 * Únicas classes cuja mensagem vai para o log: o texto é escrito por nós e leva no máximo ids, estados e nomes de variáveis.
 * Ficam de fora as nossas cuja mensagem repete a entrada (`InvalidMoneyError`, `CurrencyMismatchError`, `MalformedMessageError` e
 * `UnknownMessageTypeError`). Classe nova só entra aqui depois de conferida a mensagem.
 */
const CLASSES_WITH_SAFE_MESSAGE: ReadonlySet<unknown> = new Set([
  WalletNotFoundError, WalletAlreadyExistsError, IdempotencyConflictError, WagerTransactionNotFoundError, InvalidCursorError,
  TransientInfrastructureError, InboxPayloadConflictError,
  MoneyOverflowError, InsufficientBalanceError, LedgerEntryNotBalancedError, InvalidWagerTransactionError, InvalidTransactionStateError,
  InvalidInboxMessageError, InvalidOutboxMessageError, InvalidIntegrationEventError,
  ConfigurationError,
]);

/**
 * Nome e código do erro; a mensagem só para a lista acima, comparada pela classe exata (subclasse não herda). Qualquer outra exceção
 * (driver, ORM, biblioteca, rede ou um `Error` genérico) pode trazer SQL com os valores da requisição, então a mensagem dela nunca é
 * logada. A causa (um nível) entra só com nome e código. Valor que não é `Error` (alguém lançou uma string ou um objeto) loga só o tipo.
 */
export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = stringCode(error);
  const described: ErrorDescription = { errorName: error.name };
  if (code !== undefined) described.errorCode = code;
  if (CLASSES_WITH_SAFE_MESSAGE.has(error.constructor)) described.errorMessage = error.message;
  if (error.cause instanceof Error) {
    described.causeName = error.cause.name;
    const causeCode = stringCode(error.cause);
    if (causeCode !== undefined) described.causeCode = causeCode;
  }
  return described;
}
