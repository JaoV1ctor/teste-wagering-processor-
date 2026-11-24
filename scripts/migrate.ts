import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { createOrmConfig } from '../src/infrastructure/persistence/orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  process.stderr.write('uso: bun run scripts/migrate.ts <up|down>\n');
  process.exit(2);
}

const orm = await MikroORM.init({
  ...createOrmConfig(),
  discovery: { warnWhenNoEntities: false }, // migrations só executam SQL; não dependem de entidades
  extensions: [Migrator],
});
try {
  const migrator = orm.migrator;
  // down sem argumento desfaz UMA versão (typings do IMigrator.down)
  const done = direction === 'up' ? await migrator.up() : await migrator.down();
  process.stdout.write(`${direction}: ${done.length} migration(s) executada(s) ${done.map((m) => m.name).join(', ')}\n`);
} finally {
  await orm.close();
}
