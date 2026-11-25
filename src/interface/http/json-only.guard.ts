import { type CanActivate, type ExecutionContext, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A API só aceita JSON. O Express interpreta formulários por padrão, e um formulário é o que uma página de outra origem consegue enviar sem
 * preflight: sem autenticação, isso criaria wallets a partir do navegador de quem está na rede.
 */
@Injectable()
export class JsonOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const type = context.switchToHttp().getRequest<HttpRequest>().headers['content-type'];
    if (typeof type === 'string' && type.trim().toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new UnsupportedMediaTypeException();
    return true;
  }
}
