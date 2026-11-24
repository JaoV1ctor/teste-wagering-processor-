import { setTimeout as sleep } from 'node:timers/promises';
import { ConnectionException, DeadlockException } from '@mikro-orm/core';
import { TransientInfrastructureError } from '../../application/errors';

/** SQLSTATE e códigos de socket em que reenviar o MESMO trabalho pode dar certo. */
const TRANSIENT_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available: lock_timeout estourou; quem segurava o lock pode ter terminado no reenvio
  '57P01', // admin_shutdown
  '08000', '08003', '08006', // connection_exception, connection_does_not_exist, connection_failure
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
]);

export function isTransient(error: unknown): boolean {
  if (error instanceof DeadlockException || error instanceof ConnectionException) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && TRANSIENT_CODES.has(error.code);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

/** Retry curto com jitter total; esgotado, vira `TransientInfrastructureError` (503 / não-ack). Erros permanentes passam intactos. */
export async function withTransientRetry<T>(work: () => Promise<T>, { attempts = 3, baseDelayMs = 20 }: RetryOptions = {}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isTransient(error)) throw error;
      if (attempt >= attempts) throw new TransientInfrastructureError(error);
      await sleep(Math.random() * baseDelayMs * 2 ** attempt);
    }
  }
}
