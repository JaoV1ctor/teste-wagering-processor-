import type { SQSClient } from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import type { UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case';
import { DEFAULT_REPROCESS_BATCH_SIZE, ReprocessPendingReferencesUseCase } from './application/reprocess-pending-references.use-case';
import { optionalPositiveInt } from './infrastructure/env';
import { loadWagerConsumerConfig } from './infrastructure/messaging/consumer-config';
import { loadOutboxConfig, type OutboxConfig } from './infrastructure/messaging/outbox-config';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SqsMessageQueue } from './infrastructure/messaging/sqs-message-queue';
import { DEFAULT_LOCK_TIMEOUT_MS, MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { describeError, logJson } from './infrastructure/observability/json-log';
import { createOrmConfig } from './infrastructure/persistence/orm.config';
import { PollingWorker } from './infrastructure/workers/polling-worker';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';
import { QueueConsumer } from './interface/sqs/queue-consumer';
import { WAGER_CONSUMER_NAME, WagerMessageHandler } from './interface/sqs/wager-message-handler';

const ORM = Symbol('ORM');
const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
const SQS_CLIENT = Symbol('SQS_CLIENT');
const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');
/** Dois loops do mesmo tipo (`PollingWorker`): o token distingue qual é qual na injeção. */
export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');
export const OUTBOX_PUBLISHER_WORKER = Symbol('OUTBOX_PUBLISHER_WORKER');
const POLL_INTERVAL_MS = 1000;

/** Composição: os casos de uso são classes puras; o Nest só os instancia com as portas já resolvidas. */
@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: ORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    {
      provide: UNIT_OF_WORK,
      inject: [ORM],
      useFactory: (orm: MikroORM) =>
        new MikroOrmUnitOfWork(orm, { lockTimeoutMs: optionalPositiveInt('LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS) }),
    },
    { provide: CreateWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new CreateWalletUseCase(uow) },
    { provide: GetWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow) },
    { provide: ListLedgerUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new ListLedgerUseCase(uow) },
    { provide: ProcessWagerTransactionUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new ProcessWagerTransactionUseCase(uow) },
    { provide: GetWagerTransactionUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow) },
    {
      provide: ReprocessPendingReferencesUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) =>
        new ReprocessPendingReferencesUseCase(uow, {
          onError: (error, { id, walletId }) => logJson('error', 'pending_reference_reprocess_failed', { transactionId: id, walletId, ...describeError(error) }),
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
      inject: [SQS_CLIENT, ProcessWagerTransactionUseCase],
      useFactory: (client: SQSClient, useCase: ProcessWagerTransactionUseCase) => {
        const config = loadWagerConsumerConfig();
        const handler = new WagerMessageHandler(useCase, { consumerName: WAGER_CONSUMER_NAME, backoff: config.backoff, log: logJson });
        return new QueueConsumer(new SqsMessageQueue(client, config.queues), handler, { ...config.consumer, log: logJson });
      },
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
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
