// Processo FILHO do teste de workers concorrentes: uma instância própria (pool próprio) do worker de PENDING_REFERENCE.
// Roda `runOnce()` até não haver mais nada a reivindicar e imprime `RESULT:<json>` com o total de cada desfecho.
// O relógio anda `CLOCK_OFFSET_MS` à frente para que as pendências recém-criadas já estejam vencidas.
import { MikroORM } from '@mikro-orm/postgresql';
import { ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';

const offset = Number.parseInt(process.env['CLOCK_OFFSET_MS'] ?? '0', 10);
const batchSize = Number.parseInt(process.env['WORKER_BATCH_SIZE'] ?? '5', 10);

const orm = await MikroORM.init(createOrmConfig());
const worker = new ReprocessPendingReferencesUseCase(new MikroOrmUnitOfWork(orm), {
  clock: () => new Date(Date.now() + offset),
  batchSize,
  onError: (error) => process.stderr.write(`${String(error)}\n`),
});

const total = { claimed: 0, processed: 0, rejected: 0, rescheduled: 0, skipped: 0, failed: 0 };
for (;;) {
  const summary = await worker.runOnce();
  for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += summary[key];
  if (summary.claimed === 0) break;
}
await orm.close();
process.stdout.write(`RESULT:${JSON.stringify(total)}\n`);
process.exit(0);
