import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Metrics } from '../../infrastructure/observability/metrics';
import { OpenRoute } from './auth.guard';

export const METRICS = Symbol('METRICS');

interface HeaderSetter {
  set(name: string, value: string): unknown;
}

/** Exposição Prometheus. Sem autenticação, como os health checks: quem raspa é a infraestrutura, dentro da rede. */
@OpenRoute()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  @Get()
  async scrape(@Res({ passthrough: true }) response: HeaderSetter): Promise<string> {
    response.set('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
