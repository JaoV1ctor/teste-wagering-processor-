import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';

/** Campos que identificam o conteúdo de uma transação. Cabeçalhos e metadados de transporte ficam de fora (SPEC D5). */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

/** JSON determinístico: chaves ordenadas recursivamente, sem espaços. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computePayloadHash(input: PayloadHashInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}
