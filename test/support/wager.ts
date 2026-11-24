import { randomUUID as uuid } from 'node:crypto';
import type { Api } from './app';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  /** id no provedor da transação referenciada (REFUND/ROLLBACK; opcional em WIN/LOSS). */
  referenceExternalTransactionId?: string;
}

/** Corpo válido de POST /wagering/transactions; `externalTransactionId` único por chamada. */
export function wagerPayload(wallet: { walletId: string; playerId: string }, overrides: Partial<WagerPayload> = {}): WagerPayload {
  return {
    providerId: 'provider-a', externalTransactionId: `ext-${uuid()}`, playerId: wallet.playerId, walletId: wallet.walletId,
    roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, ...overrides,
  };
}

/** REFUND/ROLLBACK de `reference`: mesmo provider, rodada, jogo e valor; `externalTransactionId` novo. `overrides` altera o que o teste quer violar. */
export function reversalPayload(
  wallet: { walletId: string; playerId: string },
  reference: WagerPayload,
  kind: 'REFUND' | 'ROLLBACK',
  overrides: Partial<WagerPayload> = {},
): WagerPayload {
  return wagerPayload(wallet, {
    providerId: reference.providerId, roundId: reference.roundId, gameId: reference.gameId, money: reference.money, kind,
    referenceExternalTransactionId: reference.externalTransactionId, ...overrides,
  });
}

/** Chave padrão recomendada pelo README: `{providerId}:{externalTransactionId}`. */
export const defaultKey = (payload: Pick<WagerPayload, 'providerId' | 'externalTransactionId'>): string =>
  `${payload.providerId}:${payload.externalTransactionId}`;

export const submit = (api: Api, payload: unknown, key: string | undefined) =>
  api.call('POST', '/wagering/transactions', payload, key === undefined ? {} : { 'idempotency-key': key });

/** Abre uma wallet pela API real e devolve os ids. */
export async function openWallet(api: Api, balance: string, playerId: string = uuid()): Promise<{ walletId: string; playerId: string }> {
  const res = await api.call('POST', '/wallets', { playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`falha ao abrir wallet: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}
