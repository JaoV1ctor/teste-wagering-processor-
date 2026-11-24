import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Migration } from '@mikro-orm/migrations';

const read = (file: string): string => readFileSync(join(import.meta.dir, '..', file), 'utf8');

/**
 * Executa EXATAMENTE db/001_init.up.sql / db/001_init.down.sql (validados em Postgres real).
 * O texto vai inteiro em uma única query: as funções PL/pgSQL usam `$$` e não podem ser partidas por `;`.
 */
export class InitMigration extends Migration {
  override up(): void {
    this.addSql(read('001_init.up.sql'));
  }

  override down(): void {
    this.addSql(read('001_init.down.sql'));
  }
}
