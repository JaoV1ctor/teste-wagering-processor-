/** Chamadas HTTP do gerador, com a latência medida pelo relógio de alta resolução do Bun (do envio até o corpo lido). */
import { randomUUID } from 'node:crypto';

export interface Wallet {
  walletId: string;
  playerId: string;
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface SubmitOutcome {
  /** Status HTTP, ou o motivo de não haver resposta. */
  status: number | 'timeout' | 'network';
  latencyMs: number;
  transactionId?: string;
  idempotentReplay?: boolean;
}

const REQUEST_TIMEOUT_MS = 60_000;

export const idempotencyKeyOf = (payload: WagerPayload): string => `${payload.providerId}:${payload.externalTransactionId}`;

export async function submit(baseUrl: string, payload: WagerPayload): Promise<SubmitOutcome> {
  const started = Bun.nanoseconds();
  const elapsed = () => (Bun.nanoseconds() - started) / 1e6;
  try {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKeyOf(payload) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json()) as { transactionId?: string; idempotentReplay?: boolean };
    return {
      status: response.status,
      latencyMs: elapsed(),
      ...(body.transactionId === undefined ? {} : { transactionId: body.transactionId }),
      ...(body.idempotentReplay === undefined ? {} : { idempotentReplay: body.idempotentReplay }),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { status: timedOut ? 'timeout' : 'network', latencyMs: elapsed() };
  }
}

export async function openWallet(baseUrl: string, initialBalance: string): Promise<Wallet> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialBalance, currency: 'BRL' } }),
  });
  if (response.status !== 201) throw new Error(`falha ao abrir wallet: HTTP ${response.status}`);
  const body = (await response.json()) as { id: string };
  return { walletId: body.id, playerId };
}

export async function reconcile(baseUrl: string, walletId: string): Promise<{ consistent: boolean }> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
  if (response.status !== 200) throw new Error(`reconciliação falhou: HTTP ${response.status}`);
  return (await response.json()) as { consistent: boolean };
}

/** Soma das séries de `/metrics` das instâncias, por linha de amostra (nome com labels). */
export async function scrapeMetrics(baseUrls: readonly string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const url of baseUrls) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      const match = /^(wager_[a-z_]+(?:\{[^}]*\})?) (\S+)$/.exec(line);
      if (!match) continue;
      totals.set(match[1]!, (totals.get(match[1]!) ?? 0) + parseFloat(match[2]!));
    }
  }
  return totals;
}
