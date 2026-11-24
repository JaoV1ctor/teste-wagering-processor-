import { optionalPositiveInt, requireEnv } from '../env';
import type { SqsQueueNames } from './sqs-message-queue';

/**
 * Padrões do consumidor, todos sobrescrevíveis por variável de ambiente (nomes em `.env.example`). Cada número tem uma razão:
 *  - concurrency 5: cada mensagem em processamento ocupa uma conexão do pool (padrão do `pg`: 10), que o HTTP e o worker também usam.
 *  - batchSize 10 e waitTimeSeconds 20: o máximo do ReceiveMessage e o long polling da SPEC §8.1 (menos chamadas vazias).
 *  - visibilityTimeoutSeconds 30: bem acima do pior caso de um processamento (3 tentativas de lock_timeout de 3 s ≈ 9 s), igual ao da fila.
 *  - retryBaseSeconds 5 e retryMaxSeconds 120: com maxReceiveCount = 5, as 4 esperas somam ~1 min (5+10+20+40 sem jitter) antes da DLQ:
 *    cobre um failover ou reinício de Postgres sem esgotar as tentativas em segundos. Estimativa, não medição.
 *  - shutdownTimeoutMs 25000: abaixo dos 30 s de graça típicos do orquestrador entre SIGTERM e SIGKILL.
 *  - receiveErrorPauseMs 1000: se o SQS estiver fora, tenta de novo a cada segundo em vez de em laço apertado.
 */
export const CONSUMER_DEFAULTS = {
  concurrency: 5,
  batchSize: 10,
  waitTimeSeconds: 20,
  visibilityTimeoutSeconds: 30,
  retryBaseSeconds: 5,
  retryMaxSeconds: 120,
  shutdownTimeoutMs: 25_000,
  receiveErrorPauseMs: 1000,
} as const;

/** Limites do ReceiveMessage do SQS. */
const SQS_MAX_BATCH_SIZE = 10;
const SQS_MAX_WAIT_TIME_SECONDS = 20;

export interface WagerConsumerConfig {
  queues: SqsQueueNames;
  consumer: {
    concurrency: number;
    batchSize: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    shutdownTimeoutMs: number;
    receiveErrorPauseMs: number;
  };
  backoff: { baseSeconds: number; maxSeconds: number };
}

/** Lê e valida tudo na subida: configuração inválida derruba o boot, nunca o meio de uma mensagem. */
export function loadWagerConsumerConfig(): WagerConsumerConfig {
  const batchSize = optionalPositiveInt('SQS_BATCH_SIZE', CONSUMER_DEFAULTS.batchSize);
  const waitTimeSeconds = optionalPositiveInt('SQS_WAIT_TIME_SECONDS', CONSUMER_DEFAULTS.waitTimeSeconds);
  const baseSeconds = optionalPositiveInt('SQS_RETRY_BASE_SECONDS', CONSUMER_DEFAULTS.retryBaseSeconds);
  const maxSeconds = optionalPositiveInt('SQS_RETRY_MAX_SECONDS', CONSUMER_DEFAULTS.retryMaxSeconds);
  if (batchSize > SQS_MAX_BATCH_SIZE) throw new Error(`SQS_BATCH_SIZE deve ser no máximo ${SQS_MAX_BATCH_SIZE} (limite do ReceiveMessage)`);
  if (waitTimeSeconds > SQS_MAX_WAIT_TIME_SECONDS) throw new Error(`SQS_WAIT_TIME_SECONDS deve ser no máximo ${SQS_MAX_WAIT_TIME_SECONDS}`);
  if (maxSeconds < baseSeconds) throw new Error('SQS_RETRY_MAX_SECONDS não pode ser menor que SQS_RETRY_BASE_SECONDS');
  return {
    queues: { queueName: requireEnv('SQS_WAGER_QUEUE_NAME'), deadLetterQueueName: requireEnv('SQS_WAGER_DLQ_NAME') },
    consumer: {
      concurrency: optionalPositiveInt('SQS_CONSUMER_CONCURRENCY', CONSUMER_DEFAULTS.concurrency),
      batchSize,
      waitTimeSeconds,
      visibilityTimeoutSeconds: optionalPositiveInt('SQS_VISIBILITY_TIMEOUT_SECONDS', CONSUMER_DEFAULTS.visibilityTimeoutSeconds),
      shutdownTimeoutMs: optionalPositiveInt('SHUTDOWN_TIMEOUT_MS', CONSUMER_DEFAULTS.shutdownTimeoutMs),
      receiveErrorPauseMs: CONSUMER_DEFAULTS.receiveErrorPauseMs,
    },
    backoff: { baseSeconds, maxSeconds },
  };
}
