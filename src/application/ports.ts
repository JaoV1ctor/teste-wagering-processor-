import type { LedgerEntry } from '../domain/ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export interface WalletRepository {
  /** Lança `WalletAlreadyExistsError` se já existir wallet do mesmo player na mesma moeda. */
  add(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
}

export interface WagerTransactionRepository {
  add(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
}

/** Lançamento + `seq` global atribuído pelo banco (base do cursor de paginação). */
export interface LedgerRecord {
  seq: bigint;
  entry: LedgerEntry;
}

export interface ListLedgerOptions {
  /** Devolve só lançamentos com `seq` maior que este. */
  afterSeq?: bigint | undefined;
  limit: number;
}

export interface LedgerRepository {
  add(entry: LedgerEntry): Promise<void>;
  /** Em ordem crescente de `seq`. */
  listByWallet(walletId: string, options: ListLedgerOptions): Promise<LedgerRecord[]>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
}

export interface UnitOfWork {
  /**
   * Uma transação SQL: tudo ou nada. Ordem de locks/inserts obrigatória: wallet -> transação -> ledger -> outbox.
   * Reexecuta `work` em erro transitório (deadlock, serialização); por isso `work` não pode ter efeito fora do banco.
   */
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Leitura sem transação explícita. */
  read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
