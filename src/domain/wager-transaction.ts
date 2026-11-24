import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const K = WagerTransactionKind;
const S = WagerTransactionStatus;

/** Tipos que cada tipo pode referenciar (README §7 regra 3; WIN/LOSS só a BET, SPEC §3.4). Quem não aparece não referencia nada. */
const REFERENCEABLE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
  [K.Win]: [K.Bet],
  [K.Loss]: [K.Bet],
};

export const referenceableKinds = (kind: WagerTransactionKind): readonly WagerTransactionKind[] => REFERENCEABLE_KINDS[kind] ?? [];

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  /** Saldo da wallet visto ao decidir; é o que um replay devolve (SPEC §3.2). */
  observedBalance: Money | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | undefined;
}

export type CreateWagerTransactionProps = Pick<
  WagerTransactionState,
  'id' | 'providerId' | 'externalTransactionId' | 'idempotencyKey' | 'payloadHash' | 'walletId' | 'playerId' | 'roundId' | 'gameId' | 'kind' | 'money'
> & { referenceExternalTransactionId?: string; now: Date };

/**
 * Transições (SPEC §4):
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (reagendamento)
 *   PROCESSED, REJECTED, FAILED são terminais; PENDING_REFERENCE nunca volta a PENDING.
 */
export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  /** Nasce PENDING. Valida o valor e a exigência de referência por tipo (espelha o CHECK do schema). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) throw new InvalidWagerTransactionError('Transação exige valor maior que zero');
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if ((props.kind === K.Refund || props.kind === K.Rollback) && !hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if ((props.kind === K.Bet || props.kind === K.Opening) && hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} não aceita referenceExternalTransactionId`);
    }
    if (hasReference && props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('Uma transação não pode referenciar a si mesma');
    }
    const { now, referenceExternalTransactionId, ...identity } = props;
    return new WagerTransaction({
      ...identity,
      referenceExternalTransactionId,
      status: S.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: undefined,
      attempts: 0,
      nextAttemptAt: undefined,
      createdAt: now,
      updatedAt: now,
      processedAt: undefined,
    });
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id(): string { return this.state.id; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get idempotencyKey(): string { return this.state.idempotencyKey; }
  get payloadHash(): string { return this.state.payloadHash; }
  get walletId(): string { return this.state.walletId; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string { return this.state.roundId; }
  get gameId(): string { return this.state.gameId; }
  get kind(): WagerTransactionKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get status(): WagerTransactionStatus { return this.state.status; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get observedBalance(): Money | undefined { return this.state.observedBalance; }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date | undefined { return this.state.nextAttemptAt; }
  get createdAt(): Date { return this.state.createdAt; }
  get updatedAt(): Date { return this.state.updatedAt; }
  get processedAt(): Date | undefined { return this.state.processedAt; }

  markProcessed(props: { observedBalance: Money; at: Date; referenceTransactionId?: string }): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && props.referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} só é processada com referenceTransactionId`);
    }
    this.state = {
      ...this.state,
      status: S.Processed,
      referenceTransactionId: props.referenceTransactionId,
      observedBalance: props.observedBalance,
      processedAt: props.at,
      updatedAt: props.at,
    };
  }

  /** Aguarda a transação referenciada. Chamar de novo reagenda e soma a tentativa. */
  markPendingReference(nextAttemptAt: Date, at: Date): void {
    this.assertNotTerminal('markPendingReference');
    this.state = { ...this.state, status: S.PendingReference, attempts: this.state.attempts + 1, nextAttemptAt, updatedAt: at };
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal('reject');
    if (code === FailureCode.InternalPermanentError) throw new InvalidWagerTransactionError(`${code} não é uma rejeição de negócio`);
    this.state = { ...this.state, status: S.Rejected, failureCode: code, observedBalance, updatedAt: at };
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    if (code !== FailureCode.InternalPermanentError) throw new InvalidWagerTransactionError(`fail só aceita ${FailureCode.InternalPermanentError}`);
    this.state = { ...this.state, status: S.Failed, failureCode: code, updatedAt: at };
  }

  isTerminal(): boolean {
    return this.state.status === S.Processed || this.state.status === S.Rejected || this.state.status === S.Failed;
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.state.kind !== K.Loss;
  }

  requiresReference(): boolean {
    return this.state.kind === K.Refund || this.state.kind === K.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. REFUND só reverte BET; ROLLBACK reverte BET, WIN ou REFUND.
   * A reversão inverte a referência: reverter BET (débito) credita; reverter WIN ou REFUND (créditos) debita.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case K.Bet:
        return LedgerDirection.Debit;
      case K.Win:
      case K.Opening:
        return LedgerDirection.Credit;
      case K.Loss:
        throw new InvalidWagerTransactionError('LOSS não move saldo');
      case K.Refund:
      case K.Rollback:
        return reversalDirection(this, reference);
    }
  }

  toState(): WagerTransactionState {
    return { ...this.state };
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.state.id, this.state.status, attempted);
  }
}

function reversalDirection(tx: WagerTransaction, reference: WagerTransaction | undefined): LedgerDirection {
  if (!reference) throw new InvalidWagerTransactionError(`${tx.kind} exige a transação referenciada`);
  if (!referenceableKinds(tx.kind).includes(reference.kind)) throw new InvalidWagerTransactionError(`${tx.kind} não pode reverter ${reference.kind}`);
  return reference.kind === K.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
}
