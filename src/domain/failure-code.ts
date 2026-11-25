/**
 * Códigos estáveis e legíveis por máquina (tabela em docs/ARCHITECTURE.md, "Fase 3"). Todos rejeitam, exceto `INTERNAL_PERMANENT_ERROR` (status FAILED).
 * `BALANCE_LIMIT_EXCEEDED`: crédito que ultrapassaria o máximo de NUMERIC(19,2); o provedor não reenvia, a operação escala.
 */
export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  InternalPermanentError = 'INTERNAL_PERMANENT_ERROR',
}
