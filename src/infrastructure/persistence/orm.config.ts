import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { InboxMessageEntity } from './inbox-message.entity';
import { LedgerEntryEntity } from './ledger-entry.entity';
import { OutboxMessageEntity } from './outbox-message.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletEntity } from './wallet.entity';
import { InitMigration } from '../../../db/migrations/Migration20260101000000_init';
import { IdempotencyPerProviderMigration } from '../../../db/migrations/Migration20261125000000_idempotency_per_provider';
import { requireEnv } from '../env';

export function createOrmConfig() {
  return defineConfig({
    clientUrl: requireEnv('DATABASE_URL'),
    metadataProvider: ReflectMetadataProvider,
    entities: [WalletEntity, WagerTransactionEntity, LedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
    migrations: {
      // Lista explícita: sem descoberta por glob (funciona igual em Bun/TS sem build).
      migrationsList: [
        { name: 'Migration20260101000000_init', class: InitMigration },
        { name: 'Migration20261125000000_idempotency_per_provider', class: IdempotencyPerProviderMigration },
      ],
      transactional: true,
      snapshot: false, // o schema é fonte única em db/*.sql; nada de diff automático
    },
  });
}
