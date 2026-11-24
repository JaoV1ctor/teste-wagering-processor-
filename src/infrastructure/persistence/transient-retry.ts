import { setTimeout as sleep } from 'node:timers/promises';
import { ConnectionException, DeadlockException } from '@mikro-orm/core';
import { TransientInfrastructureError } from '../../application/errors';

/** SQLSTATE individuais em que reenviar o MESMO trabalho pode dar certo. */
const TRANSIENT_SQLSTATES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available: lock_timeout estourou; quem segurava o lock pode ter terminado no reenvio
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown: o servidor está reiniciando
  '57P03', // cannot_connect_now: o servidor ainda está subindo
]);

/**
 * Classes inteiras de SQLSTATE: 08 (exceção de conexão: 08000, 08001, 08003, 08004, 08006, 08007, 08P01...) e 53 (recursos insuficientes:
 * disco cheio, memória, `too_many_connections`...). Por classe, e não por lista, para valer também para códigos que o Postgres acrescentar.
 */
const TRANSIENT_SQLSTATE_CLASSES = ['08', '53'];

/** Códigos de socket do Node (`error.code`). */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * Falhas de rede que o driver ou o pool entregam SEM `code`, só na mensagem (o `pg-pool` usa as duas últimas). Frases exatas, para
 * uma mensagem de bug qualquer nunca ser confundida com infraestrutura.
 */
const NETWORK_MESSAGE = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b|Connection terminated unexpectedly|timeout exceeded when trying to connect/;

const SQLSTATE_FORMAT = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

function isTransientCode(code: string): boolean {
  if (NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code)) return true;
  return SQLSTATE_FORMAT.test(code) && TRANSIENT_SQLSTATE_CLASSES.some((sqlstateClass) => code.startsWith(sqlstateClass));
}

/** Deadlock, falha de serialização e lock_timeout: duas transações disputando a mesma linha (a métrica `wager_lock_conflicts_total`). */
const LOCK_CONFLICT_SQLSTATES = new Set(['40P01', '40001', '55P03']);

/** Examina o erro e a cadeia de `cause` (o ORM e o driver embrulham o erro original). */
export function isTransient(error: unknown): boolean {
  for (let depth = 0, current = error; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    if (current instanceof DeadlockException || current instanceof ConnectionException) return true;
    if ('code' in current && typeof current.code === 'string' && isTransientCode(current.code)) return true;
    if (current instanceof Error && NETWORK_MESSAGE.test(current.message)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Mesma busca na cadeia de `cause`: o conflito de lock é um subconjunto dos erros transitórios. */
export function isLockConflict(error: unknown): boolean {
  for (let depth = 0, current = error; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    if (current instanceof DeadlockException) return true;
    if ('code' in current && typeof current.code === 'string' && LOCK_CONFLICT_SQLSTATES.has(current.code)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Chamado a cada falha transitória; `willRetry` é falso na última tentativa (a que vira 503). Só observação: não pode alterar o fluxo. */
  onTransientFailure?: (error: unknown, willRetry: boolean) => void;
}

/** Retry curto com jitter total; esgotado, vira `TransientInfrastructureError` (503 / não-ack). Erros permanentes passam intactos. */
export async function withTransientRetry<T>(work: () => Promise<T>, { attempts = 3, baseDelayMs = 20, onTransientFailure }: RetryOptions = {}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isTransient(error)) throw error;
      onTransientFailure?.(error, attempt < attempts);
      if (attempt >= attempts) throw new TransientInfrastructureError(error);
      await sleep(Math.random() * baseDelayMs * 2 ** attempt);
    }
  }
}
