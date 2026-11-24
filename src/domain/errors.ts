/** Violação de regra ou invariante de domínio. Nunca carrega detalhes de infraestrutura. */
export abstract class DomainError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

export class InvalidMoneyError extends DomainError {}

/** Valor acima do máximo de NUMERIC(19,2). Distinto de valor inválido: é um caminho de negócio (BALANCE_LIMIT_EXCEEDED), não bug. */
export class MoneyOverflowError extends InvalidMoneyError {
  constructor() {
    super('Valor acima do máximo de NUMERIC(19,2)');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(`Moeda divergente: esperado ${expected}, recebido ${received}`);
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor() {
    super('Saldo insuficiente');
  }
}

export class LedgerEntryNotBalancedError extends DomainError {
  constructor() {
    super('Lançamento desbalanceado: balanceBefore ± valor deve ser igual a balanceAfter');
  }
}

export class InvalidWagerTransactionError extends DomainError {}

/** Transicionar um estado terminal (ou fazer uma transição proibida) é erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, status: string, attempted: string) {
    super(`Transação ${transactionId} em ${status} não aceita ${attempted}`);
  }
}

export class InvalidInboxMessageError extends DomainError {}
