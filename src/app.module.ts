import type { SQSClient } from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import type { UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case';
import { DEFAULT_REPROCESS_BATCH_SIZE, ReprocessPendingReferencesUseCase } from './application/reprocess-pending-references.use-case';
import { optionalPositiveInt } from './infrastructure/env';
import { TrustedProviderIdentity } from './infrastructure/identity/trusted-provider-identity';
import { postgresCheck, sqsCheck } from './infrastructure/health/dependency-checks';
import { ReadinessChecker } from './infrastructure/health/readiness';
import { loadWagerConsumerConfig, type WagerConsumerConfig } from './infrastructure/messaging/consumer-config';
import { loadOutboxConfig, type OutboxConfig } from './infrastructure/messaging/outbox-config';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SqsMessageQueue } from './infrastructure/messaging/sqs-message-queue';
import { DEFAULT_LOCK_TIMEOUT_MS, MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { describeError, logJson } from './infrastructure/observability/json-log';
import { Metrics } from './infrastructure/observability/metrics';
import { ObservedProcessing } from './infrastructure/observability/observed-processing';
import { ObservedReconciliation } from './infrastructure/observability/observed-reconciliation';
import { createOrmConfig } from './infrastructure/persistence/orm.config';
import { PollingWorker } from './infrastructure/workers/polling-worker';
import { AuthGuard } from './interface/http/auth.guard';
import { HideFrameworkHeader } from './interface/http/hide-framework-header';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { HealthController, READINESS } from './interface/http/health.controller';
import { METRICS, MetricsController } from './interface/http/metrics.controller';
import { PROVIDER_IDENTITY, WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';
import { QueueConsumer } from './interface/sqs/queue-consumer';
import { WAGER_CONSUMER_NAME, WagerMessageHandler } from './interface/sqs/wager-message-handler';

const ORM = Symbol('ORM');
const PROCESSING_OBSERVER = Symbol('PROCESSING_OBSERVER');
const OUTBOX_LAG_GAUGE = Symbol('OUTBOX_LAG_GAUGE');
const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
const SQS_CLIENT = Symbol('SQS_CLIENT');
const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');
const WAGER_CONSUMER_CONFIG = Symbol('WAGER_CONSUMER_CONFIG');
/** Dois loops do mesmo tipo (`PollingWorker`): o token distingue qual é qual na injeção. */
export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');
export const OUTBOX_PUBLISHER_WORKER = Symbol('OUTBOX_PUBLISHER_WORKER');
const POLL_INTERVAL_MS = 1000;
/** Prazo de cada dependência no readiness: curto para o orquestrador não ficar pendurado, longo para uma resposta normal (dezenas de ms) não falhar. */
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2000;

/** Composição: os casos de uso são classes puras; o Nest só os instancia com as portas já resolvidas. */
@Module({
  controllers: [WalletsController, WageringController, MetricsController, HealthController],
  providers: [
    { provide: ORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    // Um registry por aplicação (não global): ver Metrics. O UnitOfWork o recebe como observador de retries, conflitos e espera de lock.
    { provide: METRICS, useFactory: () => new Metrics() },
    { provide: PROCESSING_OBSERVER, inject: [METRICS], useFactory: (metrics: Metrics) => new ObservedProcessing(metrics, logJson) },
    {
      provide: UNIT_OF_WORK,
      inject: [ORM, METRICS],
      useFactory: (orm: MikroORM, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, { lockTimeoutMs: optionalPositiveInt('LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS), observer: metrics }),
    },
    {
      // O gauge do lag lê o banco no scrape; precisa do UnitOfWork, que por sua vez precisa de Metrics, então é registrado aqui e não no construtor de Metrics.
      provide: OUTBOX_LAG_GAUGE,
      inject: [METRICS, UNIT_OF_WORK],
      useFactory: (metrics: Metrics, uow: UnitOfWork) =>
        metrics.trackOutboxLag(
          async () => (await uow.read(({ outbox }) => outbox.oldestPendingAgeMs())) / 1000,
          (error) => logJson('error', 'outbox_lag_unavailable', describeError(error)),
        ),
    },
    { provide: CreateWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new CreateWalletUseCase(uow) },
    { provide: GetWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow) },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, METRICS],
      useFactory: (uow: UnitOfWork, metrics: Metrics) => new ReconcileWalletUseCase(uow, new ObservedReconciliation(metrics, logJson)),
    },
    { provide: ListLedgerUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new ListLedgerUseCase(uow) },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, PROCESSING_OBSERVER],
      useFactory: (uow: UnitOfWork, observer: ObservedProcessing) => new ProcessWagerTransactionUseCase(uow, undefined, undefined, observer),
    },
    { provide: GetWagerTransactionUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow) },
    {
      provide: ReprocessPendingReferencesUseCase,
      inject: [UNIT_OF_WORK, METRICS],
      useFactory: (uow: UnitOfWork, metrics: Metrics) =>
        new ReprocessPendingReferencesUseCase(uow, {
          onError: (error, { id, walletId }) => logJson('error', 'pending_reference_reprocess_failed', { transactionId: id, walletId, ...describeError(error) }),
          // Resolvida pelo worker (PROCESSED ou REJECTED): conta como decisão da transação, como a que saiu direto da submissão.
          onSettled: (transaction) => {
            metrics.transactionSettled(transaction.status, transaction.kind);
            logJson('info', 'pending_reference_settled', {
              correlationId: transaction.id, transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId,
              kind: transaction.kind, status: transaction.status, failureCode: transaction.failureCode,
            });
          },
        }),
    },
    {
      // Só é criado aqui; quem o inicia é o main.ts (os testes sobem o módulo sem loop em background).
      provide: PENDING_REFERENCE_WORKER,
      inject: [ReprocessPendingReferencesUseCase],
      useFactory: (useCase: ReprocessPendingReferencesUseCase) =>
        new PollingWorker(useCase, {
          pollIntervalMs: POLL_INTERVAL_MS,
          batchSize: DEFAULT_REPROCESS_BATCH_SIZE,
          onError: (error) => logJson('error', 'pending_reference_worker_pass_failed', describeError(error)),
        }),
    },
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    // Lida aqui, na criação do módulo: variável ausente ou inválida derruba o boot. Compartilhada pelo consumidor e pelo readiness.
    { provide: WAGER_CONSUMER_CONFIG, useFactory: loadWagerConsumerConfig },
    {
      provide: READINESS,
      inject: [ORM, SQS_CLIENT, WAGER_CONSUMER_CONFIG, OUTBOX_CONFIG],
      useFactory: (orm: MikroORM, client: SQSClient, consumer: WagerConsumerConfig, outbox: OutboxConfig) =>
        new ReadinessChecker([postgresCheck(orm), sqsCheck(client, [consumer.queues.queueName, outbox.queueName])], {
          timeoutMs: optionalPositiveInt('HEALTH_CHECK_TIMEOUT_MS', DEFAULT_HEALTH_CHECK_TIMEOUT_MS),
          onFailure: (dependency, error) => logJson('warn', 'readiness_check_failed', { dependency, ...describeError(error) }),
        }),
    },
    // Lida aqui, na criação do módulo: variável ausente ou inválida derruba o boot.
    { provide: OUTBOX_CONFIG, useFactory: loadOutboxConfig },
    {
      provide: PublishOutboxUseCase,
      inject: [UNIT_OF_WORK, SQS_CLIENT, OUTBOX_CONFIG],
      useFactory: (uow: UnitOfWork, client: SQSClient, config: OutboxConfig) =>
        new PublishOutboxUseCase(uow, new SqsEventPublisher(client, config.queueName), {
          batchSize: config.batchSize,
          leaseMs: config.leaseMs,
          onError: (error, context) => logJson('error', 'outbox_publish_failed', { ...context, ...describeError(error) }),
        }),
    },
    {
      // Como os outros loops, só é criado aqui; quem o inicia é o main.ts.
      provide: OUTBOX_PUBLISHER_WORKER,
      inject: [PublishOutboxUseCase, OUTBOX_CONFIG],
      useFactory: (useCase: PublishOutboxUseCase, config: OutboxConfig) =>
        new PollingWorker(useCase, {
          pollIntervalMs: config.pollIntervalMs,
          batchSize: config.batchSize,
          onError: (error) => logJson('error', 'outbox_publisher_pass_failed', describeError(error)),
        }),
    },
    {
      // Como o worker, só é criado aqui; quem o inicia é o main.ts. Mesmo ProcessWagerTransactionUseCase do HTTP.
      provide: QueueConsumer,
      inject: [SQS_CLIENT, ProcessWagerTransactionUseCase, METRICS, WAGER_CONSUMER_CONFIG],
      useFactory: (client: SQSClient, useCase: ProcessWagerTransactionUseCase, metrics: Metrics, config: WagerConsumerConfig) => {
        const handler = new WagerMessageHandler(useCase, { consumerName: WAGER_CONSUMER_NAME, backoff: config.backoff, log: logJson });
        return new QueueConsumer(new SqsMessageQueue(client, config.queues), handler, { ...config.consumer, log: logJson, observer: metrics });
      },
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    HideFrameworkHeader,
    // Ponto de extensão de autenticação (hoje no-op). `useExisting` mantém uma instância só, alcançável pelo próprio token.
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: PROVIDER_IDENTITY, useClass: TrustedProviderIdentity },
  ],
})
export class AppModule implements BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(PENDING_REFERENCE_WORKER) private readonly worker: PollingWorker,
    @Inject(OUTBOX_PUBLISHER_WORKER) private readonly publisher: PollingWorker,
    @Inject(QueueConsumer) private readonly consumer: QueueConsumer,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /**
   * Consumidor, worker e publisher param ANTES de o ORM fechar, em paralelo: o consumidor espera as mensagens em andamento (até o timeout)
   * e devolve o resto à fila; o worker e o publisher terminam a passada atual (o que o publisher já enviou e não marcou volta depois do
   * lease, como duplicata segura). Só depois `onApplicationShutdown` fecha o ORM e o cliente SQS.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.worker.stop(), this.publisher.stop()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    this.sqs.destroy();
  }
}
