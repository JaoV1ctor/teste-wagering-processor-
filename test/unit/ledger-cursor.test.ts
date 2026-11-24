import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../src/application/errors';
import { decodeCursor, encodeCursor } from '../../src/application/ledger-cursor';

describe('cursor do ledger', () => {
  test('é o base64 do seq e faz ida e volta', () => {
    const cursor = encodeCursor(12345n);
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe('12345');
    expect(decodeCursor(cursor)).toBe(12345n);
  });

  test('suporta seq acima de Number.MAX_SAFE_INTEGER', () => {
    const seq = 9007199254740993n;
    expect(decodeCursor(encodeCursor(seq))).toBe(seq);
  });

  test.each([
    ['vazio', ''],
    ['não é base64 de número', Buffer.from('abc').toString('base64url')],
    ['negativo', Buffer.from('-5').toString('base64url')],
    ['decimal', Buffer.from('1.5').toString('base64url')],
    ['zero à esquerda', Buffer.from('007').toString('base64url')],
    ['zero', Buffer.from('0').toString('base64url')],
    ['acima do bigint do Postgres', Buffer.from('9223372036854775808').toString('base64url')],
    ['caracteres fora do alfabeto', '!!!'],
    ['base64 com padding (não canônico)', `${Buffer.from('12').toString('base64')}==`],
  ])('rejeita cursor inválido: %s', (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});
