import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { ReadinessChecker } from '../../infrastructure/health/readiness';
import { OpenRoute } from './auth.guard';

export const READINESS = Symbol('READINESS');

interface StatusSetter {
  status(code: number): unknown;
}

/** Sem autenticação: quem consulta é o orquestrador. */
@OpenRoute()
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessChecker) {}

  /** Liveness: o processo responde. Não olha dependência; reiniciar o processo não conserta um Postgres fora do ar. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: Postgres E SQS alcançáveis. 503 se qualquer um cair; o corpo diz qual, sem detalhe interno. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusSetter): Promise<{ status: 'ok' | 'unavailable'; checks: Record<string, 'up' | 'down'> }> {
    const { ready, checks } = await this.readiness.run();
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks };
  }
}
