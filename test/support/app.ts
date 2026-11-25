import 'reflect-metadata';
import { randomUUID as uuid } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Cleanup, releaseOnFailure } from '../../scripts/cleanup';
import { AppModule } from '../../src/app.module';

export interface ApiBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
  code: string;
  details: unknown[];
  items: { id: string }[];
  nextCursor: string | null;
}

export interface Api {
  app: INestApplication;
  url: string;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação real (mesmo AppModule da produção) em porta efêmera, contra o Postgres do compose.
 * `env` sobrescreve variáveis SÓ durante a criação do módulo (é quando a configuração é lida): serve para apontar uma dependência
 * para um endereço morto e provar o readiness com a dependência fora do ar.
 */
export async function startApi(env: Record<string, string> = {}): Promise<Api> {
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  let app: INestApplication;
  try {
    // Sem `abortOnError: false`, uma falha ao montar a aplicação encerraria o processo do teste, sem chance de liberar nada.
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const cleanup = new Cleanup();
  cleanup.defer(() => app.close());
  const url = await releaseOnFailure(cleanup, async () => {
    await app.listen(0);
    return app.getUrl();
  });
  return {
    app,
    url,
    async call(method, path, body, headers = {}) {
      const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const res = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(raw === undefined ? {} : { body: raw }) });
      return { status: res.status, body: await res.json(), headers: res.headers };
    },
    close: () => app.close(),
  };
}

export const newPlayerId = (): string => uuid();
