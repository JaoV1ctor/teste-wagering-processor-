// UUID não distingue caixa: as bordas (DTOs HTTP e mensagem SQS) entregam sempre minúsculas. Campos que não são UUID ficam como chegaram.
import { describe, expect, test } from 'bun:test';
import { IdempotencyKeyHeader, ProviderTransactionParams, SubmitTransactionBody, TransactionIdParam } from '../../src/interface/http/wagering.dto';
import { CreateWalletBody, WalletIdParam } from '../../src/interface/http/wallets.dto';
import { parseWagerMessage } from '../../src/interface/sqs/wager-transaction-message';

const PLAYER = '0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1';
const WALLET = '0192F291-27DD-7D3F-8071-5F8685DEEF37';

/** Campos que NÃO são UUID, com maiúsculas de propósito (um deles é um UUID usado como id externo). */
const notUuid = {
  providerId: 'Provider-A', externalTransactionId: 'EXT-ABC', roundId: 'Round-9', gameId: 'Fortune-Chimp',
  referenceExternalTransactionId: '0192F298-345E-7E38-AF88-E43F851A819D',
};
const body = { ...notUuid, playerId: PLAYER, walletId: WALLET, kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' } };

describe('borda HTTP', () => {
  test('POST /wagering/transactions: walletId e playerId viram minúsculas; os demais campos não mudam', () => {
    const parsed = SubmitTransactionBody.parse(body);
    expect(parsed.walletId).toBe(WALLET.toLowerCase());
    expect(parsed.playerId).toBe(PLAYER.toLowerCase());
    expect(parsed).toMatchObject(notUuid);
  });

  test('POST /wallets: playerId vira minúsculas', () => {
    expect(CreateWalletBody.parse({ playerId: PLAYER, initialBalance: { amount: '1.00', currency: 'BRL' } }).playerId).toBe(PLAYER.toLowerCase());
  });

  test('parâmetros de rota walletId e transactionId viram minúsculas', () => {
    expect(WalletIdParam.parse(WALLET)).toBe(WALLET.toLowerCase());
    expect(TransactionIdParam.parse(WALLET)).toBe(WALLET.toLowerCase());
  });

  test('Idempotency-Key e os ids da rota por provedor não são UUID: preservam a caixa', () => {
    expect(IdempotencyKeyHeader.parse(`Provider-A:${WALLET}`)).toBe(`Provider-A:${WALLET}`);
    expect(ProviderTransactionParams.parse({ providerId: 'Provider-A', externalTransactionId: WALLET })).toEqual({ providerId: 'Provider-A', externalTransactionId: WALLET });
  });

  test('o que não é UUID continua recusado', () => {
    expect(WalletIdParam.safeParse('NAO-E-UUID').success).toBe(false);
    expect(WalletIdParam.safeParse(` ${WALLET}`).success).toBe(false);
  });
});

describe('borda SQS (parseWagerMessage)', () => {
  test('walletId e playerId viram minúsculas; idempotencyKey e os demais campos não mudam', () => {
    const idempotencyKey = `Provider-A:${WALLET}`;
    const { command, messageId } = parseWagerMessage(
      JSON.stringify({ messageId: 'MSG-1', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data: { ...body, idempotencyKey } }),
    );
    expect(command.walletId).toBe(WALLET.toLowerCase());
    expect(command.playerId).toBe(PLAYER.toLowerCase());
    expect(command).toMatchObject({ ...notUuid, idempotencyKey });
    expect(messageId).toBe('MSG-1');
  });
});
