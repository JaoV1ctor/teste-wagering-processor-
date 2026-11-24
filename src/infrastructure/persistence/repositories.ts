import { type EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, WalletAlreadyExistsError } from '../../application/errors';
import type { LedgerRecord, LedgerRepository, ListLedgerOptions, WagerTransactionRepository, WalletRepository } from '../../application/ports';
import type { LedgerEntry } from '../../domain/ledger-entry';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerEntryEntity } from './ledger-entry.entity';
import { LedgerEntryMapper } from './ledger-entry.mapper';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WalletEntity } from './wallet.entity';
import { WalletMapper } from './wallet.mapper';

/**
 * Cada `add` faz flush na hora: o INSERT sai agora, na ordem em que o caso de uso chamou
 * (wallet -> transação -> ledger), e não na ordem que o ORM escolheria no flush final.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async add(wallet: Wallet): Promise<void> {
    this.em.persist(WalletMapper.toEntity(wallet));
    try {
      await this.em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && error.message.includes('wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? WalletMapper.toDomain(entity) : undefined;
  }

  /**
   * Trava com SQL `?` (o MikroORM interpola e escapa no cliente; não é prepared statement do servidor) e só então relê:
   * em READ COMMITTED a leitura seguinte já enxerga o commit de quem segurava o lock, e ninguém altera a linha até o fim da transação.
   */
  async lockWallet(id: string): Promise<Wallet | undefined> {
    const locked = await this.em.execute<{ id: string }[]>('select id from wallets where id = ? for no key update', [id]);
    if (locked.length === 0) return undefined;
    return this.findById(id);
  }

  async saveBalance(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(WalletEntity, { id: wallet.id }, { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async add(transaction: WagerTransaction): Promise<void> {
    this.em.persist(WagerTransactionMapper.toEntity(transaction));
    await this.em.flush();
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async addIdempotent(transaction: WagerTransaction): Promise<boolean> {
    const e = WagerTransactionMapper.toEntity(transaction);
    const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
    try {
      const inserted = await this.em.execute<{ id: string }[]>(
        `insert into wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind,
           amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, observed_balance,
           attempts, next_attempt_at, created_at, updated_at, processed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (idempotency_key) do nothing returning id`,
        [
          e.id, e.providerId, e.externalTransactionId, e.idempotencyKey, e.payloadHash, e.walletId, e.playerId, e.roundId, e.gameId, e.kind,
          e.amount, e.currency, e.referenceExternalTransactionId, e.referenceTransactionId, e.status, e.failureCode, e.observedBalance,
          e.attempts, iso(e.nextAttemptAt), iso(e.createdAt), iso(e.updatedAt), iso(e.processedAt),
        ],
      );
      return inserted.length === 1;
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && error.message.includes('wt_external_id_uq')) throw new IdempotencyConflictError();
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const e = WagerTransactionMapper.toEntity(transaction);
    await this.em.nativeUpdate(WagerTransactionEntity, { id: e.id }, {
      status: e.status, referenceTransactionId: e.referenceTransactionId, failureCode: e.failureCode, observedBalance: e.observedBalance,
      attempts: e.attempts, nextAttemptAt: e.nextAttemptAt, updatedAt: e.updatedAt, processedAt: e.processedAt,
    });
  }

  async hasEffectiveReversal(referenceTransactionId: string): Promise<boolean> {
    const found = await this.em.execute<unknown[]>(
      "select 1 from wager_transactions where reference_transaction_id = ? and kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED' limit 1",
      [referenceTransactionId],
    );
    return found.length > 0;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async add(entry: LedgerEntry): Promise<void> {
    this.em.persist(LedgerEntryMapper.toEntity(entry));
    await this.em.flush();
  }

  async listByWallet(walletId: string, { afterSeq, limit }: ListLedgerOptions): Promise<LedgerRecord[]> {
    const entities = await this.em.find(
      LedgerEntryEntity,
      afterSeq === undefined ? { walletId } : { walletId, seq: { $gt: afterSeq.toString() } },
      { orderBy: { seq: 'asc' }, limit },
    );
    return entities.map((entity) => ({ seq: BigInt(entity.seq ?? ''), entry: LedgerEntryMapper.toDomain(entity) }));
  }
}
