// Executa as operações geradas contra o sistema REAL: um banco descartável, filas próprias no MiniStack, instâncias completas da aplicação
// (HTTP), consumidores SQS e o worker de PENDING_REFERENCE. Nada é simulado; o teste só observa quando cada mensagem foi liquidada.
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import pg from 'pg';
import { Cleanup, deleteQueuesWithPrefix, releaseOnFailure } from '../../../scripts/cleanup';
import { buildWagerMessage } from '../../../scripts/send-wager-message';
import { ProcessWagerTransactionUseCase } from '../../../src/application/process-wager-transaction.use-case';
import { ReprocessPendingReferencesUseCase } from '../../../src/application/reprocess-pending-references.use-case';
import { SqsMessageQueue } from '../../../src/infrastructure/messaging/sqs-message-queue';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import type { QueueConsumer } from '../../../src/interface/sqs/queue-consumer';
import { type Api, startApi } from '../app';
import { createEmptyDatabase, initOrm, type Orm } from '../db';
import { createTestConsumer, InterceptingQueue, newQueues, type TestQueues, waitFor } from '../sqs';
import type { SubmitOp, WalletOp } from './operations';

export interface HttpReply {
  status: number;
  body: any;
}
export interface QueueReply {
  /** `ack` ou o motivo com que a mensagem foi para a DLQ. */
  disposition: string;
}

const playerUuid = (alias: string): string => `00000000-0000-4000-8000-${alias.slice(1).padStart(12, '0')}`;
/** Id de uma wallet que não existe (operação cuja criação foi recusada ou retirada na redução). */
const missingWalletUuid = (alias: string): string => `00000000-0000-4000-9000-${alias.slice(1).padStart(12, '0')}`;
const HOUR_MS = 3_600_000;

export class World {
  private readonly walletIds = new Map<string, string>();
  private readonly settled = new Map<string, string>();
  private readonly consumers: QueueConsumer[] = [];
  private passes = 0;
  /** Falhas do worker em uma transação: ele as isola e segue, então o teste precisa conferir. */
  readonly workerErrors: string[] = [];

  private constructor(
    readonly probe: pg.Pool,
    private readonly orm: Orm,
    private readonly apis: Api[],
    private readonly sqs: ReturnType<typeof createSqsClient>,
    private readonly queues: TestQueues,
    private readonly cleanup: Cleanup,
  ) {}

  /** Se um passo falhar, o que os anteriores criaram é liberado antes de o erro subir. */
  static async create(instances: number, { queuePrefix = `rnd-${randomUUID().slice(0, 13)}-` } = {}): Promise<World> {
    const cleanup = new Cleanup();
    return releaseOnFailure(cleanup, async () => {
      const database = await createEmptyDatabase();
      cleanup.defer(() => database.drop());
      const orm = await initOrm(database.url);
      cleanup.defer(() => orm.close());
      await orm.migrator.up();
      const apis: Api[] = [];
      for (let i = 0; i < instances; i += 1) {
        const api = await startApi({ DATABASE_URL: database.url });
        cleanup.defer(() => api.close());
        apis.push(api);
      }
      const sqs = createSqsClient();
      cleanup.defer(() => sqs.destroy());
      const queues = await newQueues(sqs, queuePrefix);
      cleanup.defer(() => deleteQueuesWithPrefix(sqs, queuePrefix));
      const probe = new pg.Pool({ connectionString: database.url, max: 4 });
      cleanup.defer(() => probe.end());
      const world = new World(probe, orm, apis, sqs, queues, cleanup);
      // Registrado por último, roda primeiro: os consumidores param antes de as filas e o banco sumirem.
      cleanup.defer(() => Promise.all(world.consumers.map((consumer) => consumer.stop())));
      for (let i = 0; i < instances; i += 1) world.startConsumer();
      return world;
    });
  }

  async openWallet({ wallet, player, currency, initial }: WalletOp, instance = 0): Promise<HttpReply> {
    const reply = await this.api(instance).call('POST', '/wallets', { playerId: playerUuid(player), initialBalance: { amount: initial, currency } });
    if (reply.status === 201) this.walletIds.set(wallet, reply.body.id);
    return reply;
  }

  async submit(op: SubmitOp, instance = 0): Promise<HttpReply | QueueReply> {
    return op.via === 'http' ? this.submitHttp(op, instance) : this.submitQueue(op);
  }

  /** Uma passada do worker com o relógio uma hora à frente da anterior, para toda pendência estar vencida. */
  async workerPass(): Promise<void> {
    await this.worker().runOnce();
  }

  /** Reavalia uma pendência específica: a fase sequencial escolhe a ordem. */
  async reprocess(provider: string, externalId: string): Promise<void> {
    const { rows } = await this.probe.query<{ id: string; wallet_id: string }>(
      "select id, wallet_id from wager_transactions where provider_id = $1 and external_transaction_id = $2 and status = 'PENDING_REFERENCE'",
      [provider, externalId]);
    if (rows[0]) await this.worker().reprocessOne({ id: rows[0].id, walletId: rows[0].wallet_id });
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.probe.query<{ n: number }>("select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'");
    return rows[0]!.n;
  }

  /** Saldo e quantidade de lançamentos por apelido de wallet. */
  async walletStates(): Promise<Map<string, { balance: string; entries: number }>> {
    const { rows } = await this.probe.query<{ id: string; balance: string; entries: number }>(
      `select w.id, w.balance::text as balance, count(l.id)::int as entries
         from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id group by w.id`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return new Map([...this.walletIds].map(([alias, id]) => [alias, { balance: byId.get(id)!.balance, entries: byId.get(id)!.entries }]));
  }

  async transaction(provider: string, externalId: string) {
    const { rows } = await this.probe.query<{ id: string; status: string; failure_code: string | null; observed_balance: string | null }>(
      'select id, status, failure_code, observed_balance::text from wager_transactions where provider_id = $1 and external_transaction_id = $2',
      [provider, externalId]);
    return rows[0];
  }

  /** Transações vindas das operações (a de abertura é interna). */
  async submittedCount(): Promise<number> {
    const { rows } = await this.probe.query<{ n: number }>("select count(*)::int as n from wager_transactions where kind <> 'OPENING'");
    return rows[0]!.n;
  }

  /** Para os consumidores e as instâncias, apaga as filas e o banco. */
  async close(): Promise<void> {
    await this.cleanup.run();
  }

  private api(instance: number): Api {
    return this.apis[instance % this.apis.length]!;
  }

  private worker(): ReprocessPendingReferencesUseCase {
    const offset = (this.passes += 1) * HOUR_MS;
    return new ReprocessPendingReferencesUseCase(new MikroOrmUnitOfWork(this.orm), {
      clock: () => new Date(Date.now() + offset), batchSize: 500, onError: (error) => this.workerErrors.push(String(error)),
    });
  }

  private startConsumer(): void {
    const reasons = new Map<string, string>();
    const queue = new InterceptingQueue(new SqsMessageQueue(this.sqs, this.queues.names), {
      onDeadLetter: async (message, reason, next) => {
        await next();
        reasons.set(message.id, reason);
      },
      // O ack é o último passo, tanto do sucesso quanto da ida à DLQ.
      onAcknowledge: async (message, next) => {
        await next();
        this.settled.set(message.id, reasons.get(message.id) ?? 'ack');
      },
    });
    const { consumer } = createTestConsumer({ queue, processor: new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(this.orm)) });
    consumer.start();
    this.consumers.push(consumer);
  }

  private walletId(alias: string): string {
    return this.walletIds.get(alias) ?? missingWalletUuid(alias);
  }

  private body({ request, defect }: SubmitOp): Record<string, unknown> {
    const body: Record<string, unknown> = {
      providerId: request.provider, externalTransactionId: request.externalId, playerId: playerUuid(request.player), walletId: this.walletId(request.wallet),
      roundId: request.round, gameId: 'g1', kind: request.kind, money: { amount: request.amount, currency: request.currency },
      ...(request.reference === undefined ? {} : { referenceExternalTransactionId: request.reference }),
    };
    const money = (amount: unknown) => ({ money: { amount, currency: request.currency } });
    switch (defect) {
      case 'negative-amount': return { ...body, ...money(`-${request.amount}`) };
      case 'zero-amount': return { ...body, ...money('0.00') };
      case 'three-decimals': return { ...body, ...money(`${request.amount}1`) };
      case 'numeric-amount': return { ...body, ...money(1.5) };
      case 'opening-kind': return { ...body, kind: 'OPENING' };
      case 'bet-with-reference': return { ...body, kind: 'BET', referenceExternalTransactionId: 'outra' };
      case 'reversal-without-reference': return { ...body, kind: 'REFUND', referenceExternalTransactionId: undefined };
      case 'self-reference': return { ...body, kind: 'REFUND', referenceExternalTransactionId: request.externalId };
      case 'unknown-field': return { ...body, extra: 1 };
      default: return body; // sem defeito; a chave ausente é aplicada no envio
    }
  }

  private async submitHttp(op: SubmitOp, instance: number): Promise<HttpReply> {
    const headers: Record<string, string> = op.defect === 'missing-key' ? {} : { 'idempotency-key': op.key };
    const { status, body } = await this.api(instance).call('POST', '/wagering/transactions', this.body(op), headers);
    return { status, body };
  }

  private async submitQueue(op: SubmitOp): Promise<QueueReply> {
    const walletId = this.walletId(op.request.wallet);
    const envelope = buildWagerMessage({
      messageId: op.messageId, providerId: op.request.provider, playerId: '', walletId, roundId: '', gameId: '', kind: '', amount: '', currency: '',
    });
    const data = { ...this.body(op), ...(op.defect === 'missing-key' ? {} : { idempotencyKey: op.key }) };
    // Id de deduplicação novo a cada envio: a repetição de uma messageId precisa chegar ao consumidor, que é quem a trata.
    const { MessageId: id } = await this.sqs.send(new SendMessageCommand({
      QueueUrl: this.queues.mainUrl, MessageBody: JSON.stringify({ ...envelope, data }), MessageGroupId: walletId, MessageDeduplicationId: randomUUID(),
    }));
    await waitFor(`mensagem ${op.messageId} liquidada`, () => this.settled.has(id!), 30_000);
    return { disposition: this.settled.get(id!)! };
  }
}
