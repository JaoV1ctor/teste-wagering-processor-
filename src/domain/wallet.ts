/**
 * SPIKE da Fase 0: prova construtor privado + factory `rehydrate` com persistência separada.
 * Só estado e leitura; regras (debit/credit, Money) entram na Fase 1.
 * `balanceCents` é bigint em centavos (nunca number para dinheiro).
 */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balanceCents: bigint;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private readonly _balanceCents: bigint,
    private readonly _version: number,
    public readonly createdAt: Date,
    private readonly _updatedAt: Date,
  ) {}

  /** Reconstrói estado já persistido; não revalida transições (README §6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balanceCents, state.version, state.createdAt, state.updatedAt);
  }

  get balanceCents(): bigint { return this._balanceCents; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  toState(): WalletState {
    return {
      id: this.id, playerId: this.playerId, currency: this.currency,
      balanceCents: this._balanceCents, version: this._version, createdAt: this.createdAt, updatedAt: this._updatedAt,
    };
  }
}
