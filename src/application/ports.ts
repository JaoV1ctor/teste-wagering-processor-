import type { InboxMessage } from '../domain/inbox-message';
import type { LedgerEntry } from '../domain/ledger-entry';
import type { OutboxMessage } from '../domain/outbox-message';
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

export interface InboxRepository {
  /**
   * `INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING`: `true` se esta transação é a dona da mensagem, `false` se já existia.
   * Com uma entrega concorrente em voo, o INSERT espera o commit dela (índice único): nunca dois donos.
   */
  addIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** Grava `processedAt` de uma mensagem que esta transação possui. */
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  /** `INSERT` do evento. Último passo de uma transação (wallet -> transação -> ledger -> outbox), na MESMA transação SQL do fato. */
  add(message: OutboxMessage): Promise<void>;
  /**
   * Claim por lease (SPEC D7): numa transação curta, escolhe até `limit` eventos não publicados e vencidos (`next_attempt_at <= now`)
   * com `FOR UPDATE SKIP LOCKED` e os agenda para `leaseUntil`. Publishers concorrentes recebem lotes disjuntos; se um morrer,
   * o evento volta a ficar elegível quando o lease vencer. A publicação acontece depois, fora desta transação. Do mais antigo ao mais novo.
   */
  claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxMessage[]>;
  /** Grava `published_at`. Não altera um evento que já foi publicado (outro publisher pode ter chegado antes). */
  markPublished(message: OutboxMessage): Promise<void>;
  /** Grava `attempts` e `next_attempt_at` depois de uma falha. Não altera um evento que já foi publicado. */
  scheduleRetry(message: OutboxMessage): Promise<void>;
}

/** Destino dos eventos (a fila `wager-events`). Lança se não conseguiu entregar; entregar duas vezes é seguro (o consumidor deduplica por `eventId`). */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
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
