// Smoke de compatibilidade (SPEC §12.2): NestJS 12 sob Bun resolve DI por tipo (emitDecoratorMetadata) e sobe HTTP.
import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Injectable()
class Dep { value = 'ok'; }

@Injectable()
class Service { constructor(readonly dep: Dep) {} }

@Controller('ping')
class PingController {
  constructor(private readonly service: Service) {}
  @Get() ping() { return { status: this.service.dep.value }; }
}

@Module({ controllers: [PingController], providers: [Dep, Service] })
class AppModule {}

test('Nest sob Bun: injeção por tipo e rota HTTP respondem', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  try {
    const url = await app.getUrl();
    const res = await fetch(`${url}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }
});
