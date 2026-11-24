import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity';
import { InitMigration } from '../../../db/migrations/Migration20260101000000_init';
import { requireEnv } from '../env';

export function createOrmConfig() {
  return defineConfig({
    clientUrl: requireEnv('DATABASE_URL'),
    metadataProvider: ReflectMetadataProvider,
    entities: [WalletEntity],
    migrations: {
      // Lista explícita: sem descoberta por glob (funciona igual em Bun/TS sem build).
      migrationsList: [{ name: 'Migration20260101000000_init', class: InitMigration }],
      transactional: true,
      snapshot: false, // o schema é fonte única em db/*.sql; nada de diff automático
    },
  });
}
