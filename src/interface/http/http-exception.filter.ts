import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { describeError, logJson } from '../../infrastructure/observability/json-log';
import { toHttpError } from './error-mapper';
import { CorrelationIdHeader } from './wagering.dto';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  status(code: number): { set(headers: Record<string, string>): { json(body: unknown): void } };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body, headers } = toHttpError(exception);
    const http = host.switchToHttp();
    if (status >= 500) logJson('error', 'request_failed', { status, correlationId: correlationIdOf(http.getRequest<HttpRequest>()), ...describeError(exception) });
    http.getResponse<HttpResponse>().status(status).set(headers ?? {}).json(body);
  }
}

/** Nunca registra o corpo da requisição: só o id de correlação (o mesmo limite do header que o controller valida) e o resultado. */
function correlationIdOf(request: HttpRequest): string | undefined {
  const parsed = CorrelationIdHeader.safeParse(request.headers['x-correlation-id']);
  return parsed.success ? parsed.data : undefined;
}
