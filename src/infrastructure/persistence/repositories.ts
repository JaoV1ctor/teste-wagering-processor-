import { type EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../application/errors';
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
