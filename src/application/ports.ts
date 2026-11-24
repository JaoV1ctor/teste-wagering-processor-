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

/** Transação PENDING_REFERENCE reivindicada pelo worker: o `walletId` permite travar a wallet ANTES de reler a transação. */
export interface ClaimedPendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  add(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /**
   * `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`: `true` se gravou, `false` se a chave já existia (o chamador relê).
   * Lança `IdempotencyConflictError` se (provider, externalTransactionId) já existir com outra chave.
   */
  addIdempotent(transaction: WagerTransaction): Promise<boolean>;
  /**
   * `UPDATE` do estado de uma transação NÃO terminal já gravada (PENDING_REFERENCE -> PROCESSED | REJECTED | PENDING_REFERENCE).
   * Só muda as colunas de estado; a identidade é imutável (trigger). Lança se a transação já for terminal. Wallet travada antes.
   */
  update(transaction: WagerTransaction): Promise<void>;
  /**
   * Claim por lease (SPEC D7): numa transação curta e SEM wallet, escolhe até `limit` PENDING_REFERENCE vencidas
   * (`next_attempt_at <= now`) com `FOR UPDATE SKIP LOCKED` e as agenda para `leaseUntil`. Dois workers recebem lotes disjuntos;
   * se um morrer, a transação volta a ficar elegível quando o lease vencer. O processamento acontece depois, fora desta transação.
   */
  claimDuePendingReference(now: Date, limit: number, leaseUntil: Date): Promise<ClaimedPendingReference[]>;
  /** Existe REFUND/ROLLBACK PROCESSED que reverte `referenceTransactionId`? (README §7 regra 4; SPEC §3.1). Só reversão efetiva conta. */
  hasEffectiveReversal(referenceTransactionId: string): Promise<boolean>;
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
