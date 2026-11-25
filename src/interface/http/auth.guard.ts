import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const OPEN_ROUTE = 'openRoute';

/** Rota que nunca exige autenticação: quem a consulta é a infraestrutura (orquestrador, coletor de métricas). */
export const OpenRoute = () => SetMetadata(OPEN_ROUTE, true);

/**
 * Guard global, hoje sem autenticação (decisão documentada em docs/ARCHITECTURE.md, "Autenticação").
 * É o ponto de extensão: a validação do token entra em `authenticate`; as rotas `@OpenRoute()` continuam abertas.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean | undefined>(OPEN_ROUTE, [context.getHandler(), context.getClass()])) return true;
    return this.authenticate();
  }

  /** No-op: toda requisição é aceita. Um adaptador real lê a requisição do `ExecutionContext` e devolve `false` ou lança. */
  authenticate(): boolean {
    return true;
  }
}
