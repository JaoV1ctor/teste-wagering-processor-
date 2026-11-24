import type { LedgerEntry } from '../domain/ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export interface WalletRepository {
  /** Lança `WalletAlreadyExistsError` se já existir wallet do mesmo player na mesma moeda. */
  add(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Trava a linha (`SELECT ... FOR NO KEY UPDATE`) e devolve o estado já relido sob o lock; `undefined` se não existir.
   * É o ÚNICO ponto que trava wallet e deve ser a primeira instrução que a toca na transação (SPEC D2).
   */
  lockWallet(id: string): Promise<Wallet | undefined>;
  /** Grava saldo e `version` de uma wallet travada por `lockWallet` na MESMA transação. */
  saveBalance(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  add(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /**
   * `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`: `true` se gravou, `false` se a chave já existia (o chamador relê).
   * Lança `IdempotencyConflictError` se (provider, externalTransactionId) já existir com outra chave.
   */
  addIdempotent(transaction: WagerTransaction): Promise<boolean>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
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
