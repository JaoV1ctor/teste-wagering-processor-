/** Códigos estáveis e legíveis por máquina (SPEC §5.1). Todos rejeitam, exceto `INTERNAL_PERMANENT_ERROR` (status FAILED). */
export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
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
