import 'reflect-metadata';
import { randomUUID as uuid } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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

/** Sobe a aplicação real (mesmo AppModule da produção) em porta efêmera, contra o Postgres do compose. */
export async function startApi(): Promise<Api> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const url = await app.getUrl();
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
