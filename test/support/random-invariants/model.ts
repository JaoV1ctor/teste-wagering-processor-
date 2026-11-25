// Modelo de referência, em memória, só para o teste. Escrito a partir das regras do contrato e de propósito sem importar nada do domínio:
// se usasse o código que está sendo testado, concordaria com os defeitos dele.
import type { Currency, Op, Request, SubmitOp, WalletOp } from './operations';

const LIMIT = 10n ** 19n - 1n; // NUMERIC(19,2), em centavos
const MAX_WAITS = 8;

export const toCents = (amount: string): bigint => BigInt(amount.replace('.', ''));

export type Status = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';

export interface ModelWallet {
  player: string;
  currency: Currency;
  balance: bigint;
  entries: number;
}

export interface ModelTransaction {
  request: Request;
  status: Status;
  failureCode?: string;
  /** Saldo visto na decisão; `null` enquanto espera a referência. Sempre na moeda da wallet. */
  observed: bigint | null;
  waits: number;
  reversed: boolean;
}

export type Expected =
  | { outcome: 'wallet-created' | 'wallet-exists' | 'invalid' | 'conflict' | 'wallet-not-found' | 'duplicate-message' | 'inbox-conflict' }
  | { outcome: 'recorded'; transaction: ModelTransaction; replay: boolean };

const fingerprint = ({ provider, externalId, wallet, player, currency, round, kind, amount, reference }: Request): string =>
  JSON.stringify([provider, externalId, wallet, player, currency, round, kind, amount, reference ?? null]);
const pair = (a: string, b: string): string => JSON.stringify([a, b]);

export class ReferenceModel {
  readonly wallets = new Map<string, ModelWallet>();
  readonly byExternalId = new Map<string, ModelTransaction>();
  private readonly byKey = new Map<string, ModelTransaction>();
  private readonly inbox = new Map<string, string>();

  apply(op: Exclude<Op, { type: 'worker' }>): Expected {
    return op.type === 'wallet' ? this.openWallet(op) : this.submit(op);
  }

  /** Uma passada do worker: reavalia, na ordem de chegada, tudo o que espera referência. */
  resolvePending(): ModelTransaction[] {
    const pending = this.pending();
    for (const transaction of pending) this.settle(transaction);
    return pending;
  }

  pending(): ModelTransaction[] {
    return [...this.byExternalId.values()].filter((t) => t.status === 'PENDING_REFERENCE');
  }

  private openWallet({ wallet, player, currency, initial }: WalletOp): Expected {
    if ([...this.wallets.values()].some((w) => w.player === player && w.currency === currency)) return { outcome: 'wallet-exists' };
    const balance = toCents(initial);
    this.wallets.set(wallet, { player, currency, balance, entries: balance > 0n ? 1 : 0 });
    return { outcome: 'wallet-created' };
  }

  private submit(op: SubmitOp): Expected {
    if (op.defect !== undefined) return { outcome: 'invalid' };
    const { request } = op;
    const hash = fingerprint(request);
    const queued = op.via === 'sqs';
    if (queued) {
      const seen = this.inbox.get(op.messageId);
      if (seen !== undefined) return { outcome: seen === hash ? 'duplicate-message' : 'inbox-conflict' };
    }
    const key = pair(request.provider, op.key);
    const known = this.byKey.get(key);
    let expected: Expected;
    if (known) {
      if (fingerprint(known.request) !== hash) return { outcome: 'conflict' };
      expected = { outcome: 'recorded', transaction: known, replay: true };
    } else {
      if (!this.wallets.has(request.wallet)) return { outcome: 'wallet-not-found' };
      const external = pair(request.provider, request.externalId);
      if (this.byExternalId.has(external)) return { outcome: 'conflict' };
      const transaction: ModelTransaction = { request, status: 'PENDING_REFERENCE', observed: null, waits: 0, reversed: false };
      this.settle(transaction);
      this.byKey.set(key, transaction);
      this.byExternalId.set(external, transaction);
      expected = { outcome: 'recorded', transaction, replay: false };
    }
    // A messageId só fica registrada quando o processamento é confirmado.
    if (queued) this.inbox.set(op.messageId, hash);
    return expected;
  }

  private settle(transaction: ModelTransaction): void {
    const { request } = transaction;
    const wallet = this.wallets.get(request.wallet)!;
    const reject = (failureCode: string) => Object.assign(transaction, { status: 'REJECTED', failureCode, observed: wallet.balance });
    const reversal = request.kind === 'REFUND' || request.kind === 'ROLLBACK';

    if (request.player !== wallet.player) return void reject('PLAYER_MISMATCH');
    if (request.currency !== wallet.currency) return void reject('CURRENCY_MISMATCH');

    let reference: ModelTransaction | undefined;
    if (request.reference !== undefined) {
      reference = this.byExternalId.get(pair(request.provider, request.reference));
      if (reference === undefined || reference.status === 'PENDING_REFERENCE') {
        if (transaction.waits >= MAX_WAITS) return void reject('REFERENCE_NOT_FOUND');
        transaction.waits += 1;
        return;
      }
      const other = reference.request;
      if (other.player !== request.player || other.wallet !== request.wallet || other.round !== request.round || other.currency !== request.currency) {
        return void reject('REFERENCE_MISMATCH');
      }
      const allowed = request.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
      if (!allowed.includes(other.kind)) return void reject('INVALID_REFERENCE_KIND');
      if (reference.status !== 'PROCESSED') return void reject('REFERENCE_NOT_PROCESSED');
      if (reversal && toCents(other.amount) !== toCents(request.amount)) return void reject('AMOUNT_MISMATCH');
      if (reversal && reference.reversed) return void reject('ALREADY_REVERSED');
    }

    if (request.kind !== 'LOSS') {
      const debit = request.kind === 'BET' || (request.kind === 'ROLLBACK' && reference!.request.kind !== 'BET');
      const after = wallet.balance + (debit ? -1n : 1n) * toCents(request.amount);
      if (after < 0n) return void reject(request.kind === 'BET' ? 'INSUFFICIENT_BALANCE' : 'REVERSAL_WOULD_OVERDRAW');
      if (after > LIMIT) return void reject('BALANCE_LIMIT_EXCEEDED');
      wallet.balance = after;
      wallet.entries += 1;
    }
    if (reversal) reference!.reversed = true;
    Object.assign(transaction, { status: 'PROCESSED', observed: wallet.balance });
  }
}
