import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config';

/** ORM real (Postgres do compose) com o Migrator registrado. Nunca mock. */
export async function initOrm() {
  return MikroORM.init({ ...createOrmConfig(), discovery: { warnWhenNoEntities: false }, extensions: [Migrator] });
}

export type Orm = Awaited<ReturnType<typeof initOrm>>;

/** Tabelas de negócio existentes (exclui a de controle do migrator). */
export async function businessTables(orm: Orm): Promise<string[]> {
  const rows = await orm.em.getConnection().execute<{ table_name: string }[]>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
  );
  return rows.map((r) => r.table_name);
}
