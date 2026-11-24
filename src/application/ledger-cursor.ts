import { InvalidCursorError } from './errors';

/** Maior valor de `bigint` do Postgres. */
const MAX_SEQ = 2n ** 63n - 1n;

/** Cursor opaco: base64url do `seq` do último lançamento da página. */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(seq.toString(), 'utf8').toString('base64url');
}

/** Aceita só a forma canônica que `encodeCursor` produz; qualquer outra coisa é `InvalidCursorError`. */
export function decodeCursor(cursor: string): bigint {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[1-9]\d*$/.test(text)) throw new InvalidCursorError();
  const seq = BigInt(text);
  if (seq > MAX_SEQ || encodeCursor(seq) !== cursor) throw new InvalidCursorError();
  return seq;
}
