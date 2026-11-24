import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  IdempotencyConflictError, InvalidCursorError, TransientInfrastructureError, WagerTransactionNotFoundError, WalletAlreadyExistsError, WalletNotFoundError,
} from '../../application/errors';

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface HttpErrorResponse {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const CODE_BY_STATUS: Record<number, string> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE' };

/**
 * Mapeamento único de erro -> HTTP (SPEC §5.2): o provedor decide reenviar (503), corrigir (400/409) ou desistir (422)
 * só pelo status e pelo `code`. Qualquer outra coisa é bug nosso: 500 genérico, sem vazar mensagem interna.
 */
export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Requisição inválida', details } };
  }
  if (error instanceof InvalidCursorError) return { status: 400, body: { code: 'INVALID_CURSOR', message: error.message } };
  if (error instanceof WalletNotFoundError) return { status: 404, body: { code: 'WALLET_NOT_FOUND', message: error.message } };
  if (error instanceof WagerTransactionNotFoundError) return { status: 404, body: { code: 'TRANSACTION_NOT_FOUND', message: error.message } };
  if (error instanceof IdempotencyConflictError) return { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', message: error.message } };
  if (error instanceof WalletAlreadyExistsError) return { status: 409, body: { code: 'WALLET_ALREADY_EXISTS', message: error.message } };
  if (error instanceof TransientInfrastructureError) {
    return { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço temporariamente indisponível; reenvie' }, headers: { 'Retry-After': '1' } };
  }
  const status = clientErrorStatus(error);
  if (status !== undefined) return { status, body: { code: CODE_BY_STATUS[status] ?? 'HTTP_ERROR', message: clientErrorMessage(status) } };
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Erro interno' } };
}

/** HttpException do Nest, ou erro 4xx exposto do body-parser (ex.: JSON malformado). */
function clientErrorStatus(error: unknown): number | undefined {
  if (error instanceof HttpException) return error.getStatus();
  if (typeof error === 'object' && error !== null && 'status' in error && 'expose' in error && error.expose === true) {
    return typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : undefined;
  }
  return undefined;
}

function clientErrorMessage(status: number): string {
  return status === 404 ? 'Recurso não encontrado' : 'Requisição inválida';
}
