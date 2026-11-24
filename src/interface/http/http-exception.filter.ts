import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import { toHttpError } from './error-mapper';

interface HttpResponse {
  status(code: number): { set(headers: Record<string, string>): { json(body: unknown): void } };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body, headers } = toHttpError(exception);
    if (status >= 500) this.logFailure(status, exception);
    host.switchToHttp().getResponse<HttpResponse>().status(status).set(headers ?? {}).json(body);
  }

  /** Nunca registra o corpo da requisição: só tipo e mensagem do erro. */
  private logFailure(status: number, exception: unknown): void {
    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(JSON.stringify({ event: 'request_failed', status, error: error.name, message: error.message }), error.stack);
  }
}
