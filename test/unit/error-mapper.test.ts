import { describe, expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import {
  IdempotencyConflictError, InvalidCursorError, TransientInfrastructureError, WagerTransactionNotFoundError, WalletAlreadyExistsError, WalletNotFoundError,
} from '../../src/application/errors';
import { InsufficientBalanceError, InvalidMoneyError } from '../../src/domain/errors';
import { toHttpError } from '../../src/interface/http/error-mapper';

describe('toHttpError', () => {
  test('payload inválido -> 400 VALIDATION_ERROR com detalhes por campo', () => {
    const parsed = z.strictObject({ playerId: z.uuid() }).safeParse({ playerId: 'x' });
    const { status, body } = toHttpError(parsed.error);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual([{ path: 'playerId', message: expect.any(String) }]);
  });

  test('cursor inválido -> 400', () => {
    expect(toHttpError(new InvalidCursorError()).status).toBe(400);
    expect(toHttpError(new InvalidCursorError()).body.code).toBe('INVALID_CURSOR');
  });

  test('wallet inexistente -> 404', () => {
    const { status, body } = toHttpError(new WalletNotFoundError('w1'));
    expect(status).toBe(404);
    expect(body.code).toBe('WALLET_NOT_FOUND');
  });

  test('wallet duplicada -> 409', () => {
    const { status, body } = toHttpError(new WalletAlreadyExistsError());
    expect(status).toBe(409);
    expect(body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('conflito de idempotência -> 409 IDEMPOTENCY_CONFLICT', () => {
    const { status, body } = toHttpError(new IdempotencyConflictError());
    expect(status).toBe(409);
    expect(body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('transação inexistente -> 404 TRANSACTION_NOT_FOUND', () => {
    const { status, body } = toHttpError(new WagerTransactionNotFoundError());
    expect(status).toBe(404);
    expect(body.code).toBe('TRANSACTION_NOT_FOUND');
  });

  test('falha transitória -> 503 com Retry-After', () => {
    const { status, body, headers } = toHttpError(new TransientInfrastructureError(new Error('deadlock')));
    expect(status).toBe(503);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(headers?.['Retry-After']).toBeDefined();
  });

  test('HttpException do Nest mantém o status', () => {
    expect(toHttpError(new HttpException('rota', 404)).status).toBe(404);
    expect(toHttpError(new HttpException('rota', 404)).body.code).toBe('NOT_FOUND');
  });

  test('erro de parse do body-parser (status 4xx exposto) -> 400 sem vazar internals', () => {
    const parseError = Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), { status: 400, expose: true, type: 'entity.parse.failed' });
    const { status, body } = toHttpError(parseError);
    expect(status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('bug (erro desconhecido ou invariante de domínio) -> 500 genérico, sem vazar a mensagem', () => {
    // Valor inválido é barrado no DTO; um InvalidMoneyError que chega aqui veio de dentro (dado corrompido, bug).
    const leaks = [new Error('connection string postgres://user:secret@host'), new InsufficientBalanceError(), new InvalidMoneyError('secret'), 'x'];
    for (const error of leaks) {
      const { status, body } = toHttpError(error);
      expect(status).toBe(500);
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(body)).not.toContain('secret');
    }
  });
});
