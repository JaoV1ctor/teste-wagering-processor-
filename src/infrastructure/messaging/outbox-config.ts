import { DEFAULT_OUTBOX_BATCH_SIZE, DEFAULT_OUTBOX_LEASE_MS } from '../../application/publish-outbox.use-case';
import { optionalPositiveInt, requireEnv } from '../env';

/**
 * Padrões do publisher do outbox, sobrescrevíveis por variável de ambiente (nomes em `.env.example`). Lote e lease estão justificados em
 * `publish-outbox.use-case.ts`. `pollIntervalMs` 1000: o atraso típico entre o commit e a publicação fica em ~1 s mais o envio, e uma
 * passada ociosa custa uma consulta indexada por segundo por instância (mesmo intervalo do worker de PENDING_REFERENCE). Estimativas, não medições.
 */
export const OUTBOX_DEFAULTS = {
  pollIntervalMs: 1000,
  batchSize: DEFAULT_OUTBOX_BATCH_SIZE,
  leaseMs: DEFAULT_OUTBOX_LEASE_MS,
} as const;

export interface OutboxConfig {
  /** Nome da fila padrão de eventos; a URL é resolvida na primeira publicação, então o HTTP sobe mesmo com o SQS fora. */
  queueName: string;
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
}

/** Lê e valida tudo na subida: configuração inválida derruba o boot, nunca o meio de um lote. */
export function loadOutboxConfig(): OutboxConfig {
  return {
    queueName: requireEnv('SQS_EVENTS_QUEUE_NAME'),
    pollIntervalMs: optionalPositiveInt('OUTBOX_POLL_INTERVAL_MS', OUTBOX_DEFAULTS.pollIntervalMs),
    batchSize: optionalPositiveInt('OUTBOX_BATCH_SIZE', OUTBOX_DEFAULTS.batchSize),
    leaseMs: optionalPositiveInt('OUTBOX_LEASE_MS', OUTBOX_DEFAULTS.leaseMs),
  };
}
