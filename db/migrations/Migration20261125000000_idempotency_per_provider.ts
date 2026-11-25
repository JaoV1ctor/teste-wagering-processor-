import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Migration } from '@mikro-orm/migrations';

const read = (file: string): string => readFileSync(join(import.meta.dir, '..', file), 'utf8');

/**
 * `idempotency_key` passa a ser única por provedor. Como na migration inicial, o SQL vai inteiro em uma única query (o `down` usa um bloco
 * `$$`) e a migration é transacional: se a reversão falhar na conferência, nada muda.
 */
export class IdempotencyPerProviderMigration extends Migration {
  override up(): void {
    this.addSql(read('002_idempotency_per_provider.up.sql'));
  }

  override down(): void {
    this.addSql(read('002_idempotency_per_provider.down.sql'));
  }
}
