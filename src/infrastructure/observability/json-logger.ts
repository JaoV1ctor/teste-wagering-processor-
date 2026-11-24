import type { LoggerService } from '@nestjs/common';
import { describeError, type LogLevel, logJson } from './json-log';

/**
 * Logger do Nest (boot, módulos, erros do framework) que escreve pelo MESMO `logJson`: sem ele o Nest imprime texto colorido e a saída
 * deixa de ser JSON puro. Só `log`, `warn` e `error`: debug e verbose não existem em produção aqui.
 * Mensagem que não é texto (objeto, Error) nunca é despejada inteira: vira `nest_log` com a descrição segura do erro.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  /** `error(message, stack?, context?)`: a stack do framework é descartada; o contexto é o último parâmetro de texto. */
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const last = optionalParams.at(-1);
    const fields = typeof last === 'string' ? { context: last } : {};
    if (typeof message === 'string') logJson(level, message, fields);
    else logJson(level, 'nest_log', { ...fields, ...describeError(message) });
  }
}
