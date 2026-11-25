import { Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/**
 * O Express anuncia o framework em toda resposta (`X-Powered-By`) por padrão. Desligado aqui, e não no `main.ts`, para valer em qualquer
 * processo que suba o módulo, inclusive os dos testes.
 */
@Injectable()
export class HideFrameworkHeader implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}

  onModuleInit(): void {
    this.host.httpAdapter?.getInstance<{ disable(setting: string): void }>().disable('x-powered-by');
  }
}
