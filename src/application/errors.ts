/** Falha de caso de uso que a borda traduz para um status HTTP. Distinta do erro de domínio (invariante violada). */
export abstract class ApplicationError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor() {
    super('Já existe wallet para este player nesta moeda');
  }
}

export class InvalidCursorError extends ApplicationError {
  constructor() {
    super('Cursor inválido');
  }
}

/** Deadlock, serialização ou conexão: o provedor pode reenviar. Esgotado o retry interno vira 503 / não-ack. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(cause: unknown) {
    super('Falha transitória de infraestrutura', { cause });
  }
}
