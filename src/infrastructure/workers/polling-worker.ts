import { setTimeout as sleep } from 'node:timers/promises';

/** Uma passada de trabalho que reivindica um lote por lease (PENDING_REFERENCE, outbox). `claimed` diz se o lote veio cheio. */
export interface PollingJob {
  runOnce(): Promise<{ claimed: number }>;
}

export interface PollingWorkerOptions {
  /** Espera entre passadas quando não há lote cheio. */
  pollIntervalMs: number;
  /** Tamanho do lote do claim: uma passada que o preenche indica que há mais trabalho e repete sem esperar. */
  batchSize: number;
  /** Falha de uma passada inteira (banco fora, por exemplo). Obrigatório: nada é engolido; o loop segue na próxima passada. */
  onError: (error: unknown) => void;
}

/**
 * Loop periódico dos workers por lease (PENDING_REFERENCE e outbox). Sem estado de correção: só agenda `runOnce()`. Passadas nunca se
 * sobrepõem (um único loop por instância) e `stop()` espera a passada em andamento terminar, para o encerramento da aplicação não largar
 * uma transação no meio.
 */
export class PollingWorker {
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(
    private readonly job: PollingJob,
    private readonly options: PollingWorkerOptions,
  ) {}

  get isRunning(): boolean {
    return this.loop !== undefined;
  }

  start(): void {
    if (this.loop) return;
    const abort = new AbortController();
    this.abort = abort;
    this.loop = this.run(abort.signal);
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    this.abort?.abort();
    await loop;
    this.loop = undefined;
    this.abort = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimed = 0;
      try {
        ({ claimed } = await this.job.runOnce());
      } catch (error) {
        this.options.onError(error);
      }
      if (claimed >= this.options.batchSize) continue;
      await sleep(this.options.pollIntervalMs, undefined, { signal }).catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
      });
    }
  }
}
