import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { PersistenceObserver } from '../persistence/mikro-orm-unit-of-work';

/** Latência de 5 ms a 10 s: cobre uma transação curta (dezenas de ms) e o pior caso do lock_timeout (3 s x 3 tentativas). */
const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Métricas do serviço, em um `Registry` PRÓPRIO por aplicação (não o global do prom-client): vários módulos no mesmo
 * processo (testes) não colidem nem somam valores. Só labels de cardinalidade fixa (status, kind, source); nunca ids.
 * Quem produz o dado chama estes métodos; `PersistenceObserver` e o observador do consumidor SQS são implementados aqui.
 */
export class Metrics implements PersistenceObserver {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas, por status final e tipo (replay não conta)',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicatas detectadas: replay de idempotência e mensagem repetida no inbox',
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Reexecuções depois de falha transitória: source=database (retry interno) e source=queue (mensagem devolvida ao SQS com backoff)',
    labelNames: ['source'],
    registers: [this.registry],
  });

  private readonly dlqMessages = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens que o consumidor enviou à DLQ por falha permanente (o redrive do próprio SQS por maxReceiveCount não é visível aqui)',
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Conflitos de lock: deadlock (40P01), serialização (40001) e lock_timeout (55P03)',
    registers: [this.registry],
  });

  private readonly walletLockWait = new Histogram({
    name: 'wager_wallet_lock_wait_seconds',
    help: 'Espera pelo lock da wallet (SELECT ... FOR NO KEY UPDATE), inclusive quando estoura o lock_timeout',
    buckets: SECONDS_BUCKETS,
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Duração de uma execução do caso de uso de processamento que terminou com resultado (nova, replay ou mensagem duplicada)',
    buckets: SECONDS_BUCKETS,
    registers: [this.registry],
  });

  private readonly reconciliationDivergences = new Counter({
    name: 'wager_reconciliation_divergence_total',
    help: 'Reconciliações que encontraram saldo diferente da soma do ledger (a divergência nunca é corrigida)',
    registers: [this.registry],
  });

  transactionSettled(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }

  duplicate(): void {
    this.duplicates.inc();
  }

  observeProcessing(seconds: number): void {
    this.processingDuration.observe(seconds);
  }

  reconciliationDiverged(): void {
    this.reconciliationDivergences.inc();
  }

  transientFailure({ lockConflict, willRetry }: { lockConflict: boolean; willRetry: boolean }): void {
    if (lockConflict) this.lockConflicts.inc();
    if (willRetry) this.retries.inc({ source: 'database' });
  }

  walletLockWaited(seconds: number): void {
    this.walletLockWait.observe(seconds);
  }

  /** Mensagem copiada para a DLQ pelo consumidor (decisão de falha permanente). */
  deadLettered(): void {
    this.dlqMessages.inc();
  }

  /** Mensagem devolvida ao SQS com backoff por falha transitória. */
  retried(): void {
    this.retries.inc({ source: 'queue' });
  }

  /**
   * Gauge `wager_outbox_lag_seconds`: idade do evento não publicado mais antigo, lida NO SCRAPE (não guardada), então vale para o conjunto
   * das instâncias e nunca fica velha. Se a leitura falhar (banco fora), a amostra some do scrape e `onError` registra: ausência é honesta, zero seria mentira.
   */
  trackOutboxLag(readSeconds: () => Promise<number>, onError: (error: unknown) => void): void {
    new Gauge({
      name: 'wager_outbox_lag_seconds',
      help: 'Idade, em segundos, do evento mais antigo ainda não publicado no outbox (0 se não há pendente)',
      registers: [this.registry],
      async collect() {
        try {
          this.set(await readSeconds());
        } catch (error) {
          this.reset();
          onError(error);
        }
      },
    });
  }
}
