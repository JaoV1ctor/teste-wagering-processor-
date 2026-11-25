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

/** No mesmo provedor: `Idempotency-Key` repetida com payload diferente, ou o mesmo id externo com outra chave. Nunca é replay. */
export class IdempotencyConflictError extends ApplicationError {
  constructor() {
    super('Conflito de idempotência: a chave ou a identidade do provedor já pertence a outro payload');
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  constructor() {
    super('Transação não encontrada');
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

/** Mesmo `messageId` já visto neste consumidor, porém com outro hash dos campos de negócio. Reentrega não muda o corpo: é bug do produtor; nunca resolve sozinho. */
export class InboxPayloadConflictError extends ApplicationError {
  constructor(readonly messageId: string) {
    super(`messageId ${messageId} já foi recebido com outro hash dos campos de negócio`);
  }
}
