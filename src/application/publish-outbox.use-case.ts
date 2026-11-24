import type { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, UnitOfWork } from './ports';

/**
 * Tamanho do lote e do lease (estimativas a ajustar com medição; sobrescrevíveis por env, ver `outbox-config.ts`):
 *  - lote 50: um `SendMessage` leva dezenas de milissegundos, então o lote inteiro cabe em ~1-2 s, muito abaixo do lease; e é pequeno o
 *    bastante para que dois publishers dividam um backlog em vários claims em vez de um pegar tudo.
 *  - lease 30 s: ~15x o tempo normal de um lote. Cobre uma passada lenta sem que outro publisher reivindique (duplicata); e é o atraso
 *    máximo para um evento voltar a ser publicado quando o publisher que o reivindicou morre. Mesma ordem de grandeza do lease do worker
 *    de PENDING_REFERENCE e do `VisibilityTimeout` da fila.
 */
export const DEFAULT_OUTBOX_BATCH_SIZE = 50;
export const DEFAULT_OUTBOX_LEASE_MS = 30_000;

export interface PublishSummary {
  /** Reivindicados nesta passada. */
  claimed: number;
  /** Publicados E marcados com `published_at`. */
  published: number;
  /** Falharam ao publicar (agendados com backoff) ou ao registrar o resultado (voltam quando o lease vencer). */
  failed: number;
  /** Não tentados porque o lease do lote venceu no meio da passada; outro publisher pode tê-los reivindicado, então não se publica. */
  abandoned: number;
}

export interface PublishFailureContext {
  eventId: string;
  eventType: string;
  attempts: number;
}

export interface PublishOutboxOptions {
  /** Obrigatório de propósito: uma falha nunca pode ser engolida. Quem monta o publisher decide registrar ou relançar. */
  onError: (error: unknown, context: PublishFailureContext) => void;
  clock?: () => Date;
  random?: () => number;
  batchSize?: number;
  leaseMs?: number;
}

/**
 * Publisher do outbox (SPEC §8.2, D7). `runOnce()` é uma passada: reivindica os eventos vencidos por lease (transação curta, sem I/O de rede
 * dentro dela), publica cada um FORA de qualquer transação e só então grava `published_at` (outra transação curta).
 *  - Falha ao publicar: `attempts + 1` e `next_attempt_at` com backoff exponencial e jitter. O evento nunca é descartado.
 *  - Crash depois do claim: o lease vence e o evento volta a ser reivindicado.
 *  - Crash (ou falha) entre publicar e marcar: o evento é publicado de novo depois do lease. É a entrega at-least-once: o `eventId` é estável,
 *    então o consumidor deduplica. Não existe publicação exatamente uma vez entre duas máquinas.
 * Correto com N instâncias: os claims são disjuntos (SKIP LOCKED) e nada de correção vive na memória deste objeto.
 */
export class PublishOutboxUseCase {
  private readonly onError: PublishOutboxOptions['onError'];
  private readonly clock: () => Date;
  private readonly random: (() => number) | undefined;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    { onError, clock = () => new Date(), random, batchSize = DEFAULT_OUTBOX_BATCH_SIZE, leaseMs = DEFAULT_OUTBOX_LEASE_MS }: PublishOutboxOptions,
  ) {
    this.onError = onError;
    this.clock = clock;
    this.random = random;
    this.batchSize = batchSize;
    this.leaseMs = leaseMs;
  }

  async runOnce(): Promise<PublishSummary> {
    const now = this.clock();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const claimed = await this.uow.run(({ outbox }) => outbox.claimDue(now, this.batchSize, leaseUntil));

    const summary: PublishSummary = { claimed: claimed.length, published: 0, failed: 0, abandoned: 0 };
    // Em sequência: preserva a ordem do lote (do mais antigo ao mais novo) e não abre uma rajada de conexões ao SQS.
    for (const [index, message] of claimed.entries()) {
      if (this.clock() >= leaseUntil) {
        summary.abandoned = claimed.length - index;
        break;
      }
      try {
        summary[(await this.publishOne(message)) ? 'published' : 'failed'] += 1;
      } catch (error) {
        summary.failed += 1;
        this.onError(error, contextOf(message)); // falhou ao registrar o resultado no banco; o lease devolve o evento
      }
    }
    return summary;
  }

  /** `false` se a publicação falhou (e o retry foi agendado). Lança se o banco falhou ao registrar o resultado. */
  private async publishOne(message: OutboxMessage): Promise<boolean> {
    try {
      await this.publisher.publish(message);
    } catch (error) {
      this.onError(error, contextOf(message));
      message.scheduleRetry(this.clock(), this.random);
      await this.uow.run(({ outbox }) => outbox.scheduleRetry(message));
      return false;
    }
    message.markPublished(this.clock());
    await this.uow.run(({ outbox }) => outbox.markPublished(message));
    return true;
  }
}

function contextOf(message: OutboxMessage): PublishFailureContext {
  return { eventId: message.id, eventType: message.eventType, attempts: message.attempts };
}
