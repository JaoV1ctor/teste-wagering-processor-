// Processo FILHO: um publisher do outbox completo (pool próprio no Postgres, cliente SQS próprio). Imprime `READY`, espera `GO` no stdin
// (barreira: dois filhos só começam juntos, para disputarem o mesmo outbox de verdade) e roda `runOnce()` até não haver o que reivindicar.
// Variáveis: SQS_EVENTS_QUEUE_NAME, OUTBOX_BATCH_SIZE, CLOCK_OFFSET_MS (relógio à frente: leases alheios já vencidos) e
// DIE_AFTER_PUBLISHES (n: o processo se mata com SIGKILL logo DEPOIS do n-ésimo envio e ANTES de marcar `published_at`).
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxUseCase, type PublishSummary } from '../../src/application/publish-outbox.use-case';
import type { EventPublisher } from '../../src/application/ports';
import { requireEnv } from '../../src/infrastructure/env';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';

const offset = Number.parseInt(process.env['CLOCK_OFFSET_MS'] ?? '0', 10);
const batchSize = Number.parseInt(process.env['OUTBOX_BATCH_SIZE'] ?? '7', 10);
const dieAfter = Number.parseInt(process.env['DIE_AFTER_PUBLISHES'] ?? '0', 10);

const orm = await MikroORM.init(createOrmConfig());
const sqs = createSqsClient();
const real = new SqsEventPublisher(sqs, requireEnv('SQS_EVENTS_QUEUE_NAME'));
let sent = 0;
const publisher: EventPublisher = {
  publish: async (message) => {
    await real.publish(message);
    sent += 1;
    if (dieAfter > 0 && sent >= dieAfter) process.kill(process.pid, 'SIGKILL');
  },
};
const useCase = new PublishOutboxUseCase(new MikroOrmUnitOfWork(orm), publisher, {
  clock: () => new Date(Date.now() + offset),
  batchSize,
  onError: (error) => process.stderr.write(`${String(error)}\n`),
});

process.stdout.write('READY\n');
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

const total: PublishSummary = { claimed: 0, published: 0, failed: 0, abandoned: 0 };
for (;;) {
  const summary = await useCase.runOnce();
  for (const key of Object.keys(total) as (keyof PublishSummary)[]) total[key] += summary[key];
  if (summary.claimed === 0) break;
}
await orm.close();
sqs.destroy();
process.stdout.write(`RESULT:${JSON.stringify(total)}\n`);
process.exit(0);
