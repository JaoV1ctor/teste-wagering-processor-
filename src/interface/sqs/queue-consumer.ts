import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageQueue, QueueMessage } from '../../infrastructure/messaging/message-queue';
import { describeError, type logJson } from '../../infrastructure/observability/json-log';
import type { Disposition } from './wager-message-handler';

export interface MessageHandler {
  handle(body: string, receiveCount: number): Promise<Disposition>;
}

/** O que o consumidor informa para métrica depois de executar a decisão sobre a mensagem. Só observação. */
export interface QueueObserver {
  /** A mensagem foi copiada para a DLQ (falha permanente). */
  deadLettered(): void;
  /** A mensagem foi devolvida à fila com backoff (falha transitória). */
  retried(): void;
}

export interface QueueConsumerOptions {
  /** Máximo de mensagens em processamento ao mesmo tempo neste processo (cada uma ocupa uma conexão do pool). */
  concurrency: number;
  /** Máximo por ReceiveMessage; o SQS aceita até 10. */
  batchSize: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  /** Quanto o shutdown espera as mensagens em andamento antes de devolvê-las à fila. */
  shutdownTimeoutMs: number;
  /** Pausa depois de falha no ReceiveMessage (SQS fora): evita laço apertado. */
  receiveErrorPauseMs: number;
  log: typeof logJson;
  observer?: QueueObserver;
}

/** `queued`: aguardando a vez do seu grupo; `returned`: devolvida à fila no shutdown (o resultado do processamento, se houver, é descartado). */
type State = 'queued' | 'running' | 'settled' | 'returned';

interface Entry {
  state: State;
  done: Promise<void>;
}

/**
 * Laço do consumidor SQS: long polling, despacho por grupo e execução da decisão do handler (ack, ChangeMessageVisibility, DLQ).
 *  - Grupos (MessageGroupId = walletId) diferentes rodam em paralelo até `concurrency`; o MESMO grupo é encadeado, nunca em paralelo
 *    dentro do processo, nem quando o SQS devolve várias mensagens do grupo no mesmo lote. É ordem e menos disputa de lock, não
 *    correção: a correção entre processos continua sendo do lock da wallet e do inbox no banco.
 *  - `acknowledge` só acontece depois de `handle` resolver, e `handle` só resolve depois do commit.
 *  - `stop()`: para de buscar, espera as em andamento até `shutdownTimeoutMs` e devolve o restante com ChangeMessageVisibility(0).
 */
export class QueueConsumer {
  private readonly abort = new AbortController();
  private readonly aborted = new Promise<void>((resolve) => this.abort.signal.addEventListener('abort', () => resolve(), { once: true }));
  private readonly inFlight = new Map<QueueMessage, Entry>();
  private readonly groupTails = new Map<string, Promise<void>>();
  private loop: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly queue: MessageQueue,
    private readonly handler: MessageHandler,
    private readonly options: QueueConsumerOptions,
  ) {}

  start(): void {
    if (this.loop || this.stopping) return;
    this.loop = this.poll();
  }

  /** Idempotente: chamadas repetidas esperam o mesmo encerramento. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async poll(): Promise<void> {
    const { concurrency, batchSize, waitTimeSeconds, visibilityTimeoutSeconds, receiveErrorPauseMs, log } = this.options;
    while (!this.abort.signal.aborted) {
      const free = concurrency - this.inFlight.size;
      if (free <= 0) {
        await Promise.race([this.aborted, ...[...this.inFlight.values()].map((entry) => entry.done)]);
        continue;
      }
      let messages: QueueMessage[];
      try {
        messages = await this.queue.receive({
          maxMessages: Math.min(batchSize, free), waitTimeSeconds, visibilityTimeoutSeconds, signal: this.abort.signal,
        });
      } catch (error) {
        if (this.abort.signal.aborted) break;
        log('error', 'sqs_receive_failed', describeError(error));
        await sleep(receiveErrorPauseMs, undefined, { signal: this.abort.signal }).catch(() => undefined);
        continue;
      }
      for (const message of messages) this.dispatch(message);
    }
  }

  private dispatch(message: QueueMessage): void {
    const previous = this.groupTails.get(message.groupId) ?? Promise.resolve();
    const entry: Entry = { state: 'queued', done: Promise.resolve() };
    // `process` nunca rejeita, então a cadeia do grupo nunca quebra.
    entry.done = previous.then(() => this.process(message, entry));
    this.inFlight.set(message, entry);
    this.groupTails.set(message.groupId, entry.done);
    void entry.done.then(() => {
      this.inFlight.delete(message);
      if (this.groupTails.get(message.groupId) === entry.done) this.groupTails.delete(message.groupId);
    });
  }

  private async process(message: QueueMessage, entry: Entry): Promise<void> {
    if (entry.state === 'returned') return;
    if (this.abort.signal.aborted) {
      await this.giveBack(message, entry);
      return;
    }
    entry.state = 'running';
    let disposition: Disposition;
    try {
      disposition = await this.handler.handle(message.body, message.receiveCount);
    } catch (error) {
      // O handler classifica tudo e não lança. Se lançar, é bug: não confirma, e a mensagem volta quando a visibilidade vencer.
      this.options.log('error', 'sqs_handler_crashed', { sqsMessageId: message.id, ...describeError(error) });
      if (entry.state === 'running') entry.state = 'settled';
      return;
    }
    // Devolvida no shutdown enquanto processava: o commit (se houve) vale e a reentrega será replay/duplicata. Nada a confirmar.
    if (entry.state !== 'running') return;
    try {
      await this.settle(message, disposition);
    } catch (error) {
      // Falha ao confirmar/adiar/enviar à DLQ: a mensagem não sai da fila e volta quando a visibilidade vencer (reprocessamento é seguro).
      this.options.log('error', 'sqs_settle_failed', { sqsMessageId: message.id, action: disposition.action, ...describeError(error) });
    }
    if (entry.state === 'running') entry.state = 'settled';
  }

  private async settle(message: QueueMessage, disposition: Disposition): Promise<void> {
    switch (disposition.action) {
      case 'ack':
        await this.queue.acknowledge(message);
        return;
      case 'retry':
        await this.queue.changeVisibility(message, disposition.delaySeconds);
        this.options.observer?.retried();
        return;
      case 'dead-letter':
        // Primeiro a cópia na DLQ, só depois o ack: se morrer no meio, a mensagem volta e a DLQ deduplica pelo MessageDeduplicationId.
        await this.queue.deadLetter(message, disposition.reason);
        this.options.observer?.deadLettered();
        await this.queue.acknowledge(message);
        return;
    }
  }

  private async giveBack(message: QueueMessage, entry: Entry): Promise<void> {
    entry.state = 'returned';
    try {
      await this.queue.changeVisibility(message, 0);
      this.options.log('info', 'sqs_message_returned', { sqsMessageId: message.id });
    } catch (error) {
      this.options.log('error', 'sqs_return_failed', { sqsMessageId: message.id, ...describeError(error) });
    }
  }

  private async shutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
    // As que ainda nem começaram (esperando a vez do grupo) não vão mais começar: voltam já, sem esperar as outras.
    await Promise.all([...this.inFlight].filter(([, entry]) => entry.state === 'queued').map(([message, entry]) => this.giveBack(message, entry)));

    const timer = new AbortController();
    const finished = Promise.all([...this.inFlight.values()].map((entry) => entry.done)).then(() => false);
    const timeout = sleep(this.options.shutdownTimeoutMs, undefined, { signal: timer.signal }).then(() => true, () => false);
    const timedOut = await Promise.race([finished, timeout]);
    timer.abort();
    if (!timedOut) return;
    await Promise.all(
      [...this.inFlight].filter(([, entry]) => entry.state === 'running').map(([message, entry]) => this.giveBack(message, entry)),
    );
  }
}
