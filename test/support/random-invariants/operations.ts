// Gerador determinístico das operações do teste de invariantes. A mesma (semente, quantidade, perfil) produz exatamente a mesma lista.
// Cada operação é concreta e não depende do resultado de outra (nem do banco): remover uma delas deixa as demais válidas, que é o que
// permite reduzir uma sequência que falhou. Quem decide o que cada uma deve produzir é o modelo de referência (model.ts).

/** mulberry32: gerador pseudoaleatório de 32 bits, em [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Currency = 'BRL' | 'USD';

/** Pedido de aposta. `wallet` e `player` são apelidos (w1, p1); a execução os troca pelos ids reais. */
export interface Request {
  provider: string;
  externalId: string;
  wallet: string;
  player: string;
  currency: Currency;
  round: string;
  kind: Kind;
  amount: string;
  reference?: string;
}

export const DEFECTS = [
  'negative-amount', 'zero-amount', 'three-decimals', 'numeric-amount', 'opening-kind', 'bet-with-reference', 'reversal-without-reference',
  'self-reference', 'missing-key', 'unknown-field',
] as const;
export type Defect = (typeof DEFECTS)[number];

export interface WalletOp {
  type: 'wallet';
  wallet: string;
  player: string;
  currency: Currency;
  initial: string;
}
export interface SubmitOp {
  type: 'submit';
  via: 'http' | 'sqs';
  key: string;
  /** Só usado pela fila; repetido de propósito nas reentregas. */
  messageId: string;
  request: Request;
  /** Entrada inválida: o defeito é aplicado ao corpo no envio. */
  defect?: Defect;
}
/** Passada do worker de PENDING_REFERENCE. */
export interface WorkerOp {
  type: 'worker';
}
export type Op = WalletOp | SubmitOp | WorkerOp;

export interface Profile {
  /** Quantos jogadores disputam as wallets: poucos concentram a concorrência. */
  players: number;
  maxWallets: number;
}

/** Execução padrão do teste. */
export const DEFAULT_SEEDS = [101, 202, 303];
export const DEFAULT_OPS = 150;

export const SEQUENTIAL: Profile = { players: 4, maxWallets: 8 };
export const CONCURRENT: Profile = { players: 3, maxWallets: 5 };

const PROVIDERS = ['prov-a', 'prov-b', 'prov-c'] as const;
/** Pouco abaixo do limite de NUMERIC(19,2): créditos sobre esse saldo estouram. */
const NEAR_LIMIT = '99999999999999990.00';
/** Apelido que nunca é criado: pedido para uma wallet inexistente. */
const UNKNOWN_WALLET = 'w0';

export function formatCents(cents: bigint): string {
  const digits = cents.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function generateOps(seed: number, count: number, profile: Profile): Op[] {
  const random = mulberry32(seed);
  const int = (max: number) => Math.floor(random() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const chance = (probability: number) => random() < probability;

  const ops: Op[] = [];
  const wallets: WalletOp[] = [];
  const submitted: SubmitOp[] = [];
  /** Transações citadas por uma reversão que ainda não foram enviadas (referência fora de ordem). */
  const late: Request[] = [];
  let sequence = 0;
  const next = (prefix: string) => `${prefix}${(sequence += 1)}`;

  const openWallet = (): void => {
    const player = `p${1 + int(profile.players)}`;
    const currency: Currency = chance(0.8) ? 'BRL' : 'USD';
    const roll = random();
    const initial = roll < 0.1 ? '0.00' : roll < 0.22 ? NEAR_LIMIT : formatCents(BigInt(1 + int(20_000)));
    const op: WalletOp = { type: 'wallet', wallet: next('w'), player, currency, initial };
    ops.push(op);
    // Par (jogador, moeda) repetido é recusado (409): a wallet não entra no sorteio das próximas operações.
    if (!wallets.some((w) => w.player === player && w.currency === currency)) wallets.push(op);
  };

  const amount = (): string => formatCents(chance(0.04) ? BigInt(1 + int(1_000_000)) * 1_000_000n : BigInt(1 + int(chance(0.15) ? 60_000 : 6_000)));

  const freshRequest = (kind: Kind, reference?: Request): Request => {
    const wallet = pick(wallets);
    const base: Request = reference === undefined
      ? { provider: pick(PROVIDERS), externalId: next('e'), wallet: wallet.wallet, player: wallet.player, currency: wallet.currency, round: pick(['r1', 'r2']), kind, amount: amount() }
      : { ...reference, externalId: next('e'), kind, reference: reference.externalId };
    if (reference === undefined) {
      if (chance(0.03)) base.player = `p${profile.players + 1}`;
      if (chance(0.03)) base.currency = base.currency === 'BRL' ? 'USD' : 'BRL';
    }
    return base;
  };

  const send = (request: Request, extra: Partial<SubmitOp> = {}): void => {
    const op: SubmitOp = {
      type: 'submit', via: chance(0.25) ? 'sqs' : 'http', key: `${request.provider}:${request.externalId}`, messageId: next('m'), request, ...extra,
    };
    ops.push(op);
    if (op.defect === undefined) submitted.push(op);
  };

  /** Reversão de `target`, às vezes violando uma das regras da referência. */
  const reversalOf = (target: Request): Request => {
    const request = freshRequest(chance(0.5) ? 'REFUND' : 'ROLLBACK', target);
    if (chance(0.06)) request.amount = amount();
    if (chance(0.04)) request.round = 'r9';
    if (chance(0.04)) request.provider = pick(PROVIDERS);
    if (chance(0.04)) {
      const other = pick(wallets);
      Object.assign(request, { wallet: other.wallet, player: other.player, currency: other.currency });
    }
    return request;
  };

  /** Mudança que altera o payloadHash, mantendo a chave. */
  const divergent = (request: Request): Request =>
    pick<Request>([
      { ...request, amount: formatCents(BigInt(request.amount.replace('.', '')) + 1n) },
      { ...request, round: `${request.round}-x` },
      { ...request, externalId: next('e') },
    ]);

  openWallet();
  openWallet();
  openWallet();

  while (ops.length < count) {
    const roll = random();
    const earlier = submitted.length > 0 ? pick(submitted) : undefined;
    const target = earlier?.request;
    if (late.length > 0 && chance(0.12)) send(late.shift()!);
    else if (roll < 0.05 && wallets.length < profile.maxWallets) openWallet();
    else if (roll < 0.25) send(freshRequest('BET'));
    else if (roll < 0.35) {
      const kind = chance(0.65) ? 'WIN' : 'LOSS';
      send(freshRequest(kind, target !== undefined && chance(0.4) ? target : undefined));
    } else if (roll < 0.52 && target) send(reversalOf(target));
    else if (roll < 0.59) {
      // Reversão dupla: outra reversão de algo que já foi citado por uma.
      const reversed = submitted.filter((op) => op.request.kind === 'REFUND' || op.request.kind === 'ROLLBACK');
      const first = reversed.length > 0 ? pick(reversed).request : undefined;
      const original = first && submitted.find((op) => op.request.externalId === first.reference)?.request;
      if (original) send(reversalOf(original));
    } else if (roll < 0.65) {
      // A reversão chega antes da referência. Uma em cada quatro referências nunca chega.
      const bet = freshRequest(chance(0.75) ? 'BET' : 'WIN');
      send(reversalOf(bet));
      if (chance(0.75)) late.push(bet);
    } else if (roll < 0.74 && earlier) {
      ops.push({ ...earlier, messageId: next('m'), via: chance(0.25) ? 'sqs' : 'http' }); // replay idêntico
    } else if (roll < 0.80 && earlier) send(divergent(earlier.request), { key: earlier.key });
    else if (roll < 0.84 && earlier) {
      // A mesma chave em outro provedor: outra transação.
      send({ ...freshRequest('BET'), provider: pick(PROVIDERS.filter((p) => p !== earlier.request.provider)) }, { key: earlier.key });
    } else if (roll < 0.87 && target) send(target, { key: next('k') }); // mesmo id externo, outra chave
    else if (roll < 0.91) {
      const queued = submitted.filter((op) => op.via === 'sqs');
      if (queued.length === 0) continue;
      const original = pick(queued);
      // Reentrega da mesma messageId: igual (duplicata) ou com outro conteúdo (conflito no inbox).
      ops.push(chance(0.6) ? { ...original } : { ...original, request: divergent(original.request) });
    } else if (roll < 0.93) send(freshRequest(chance(0.5) ? 'BET' : 'WIN'), { defect: pick(DEFECTS) });
    else if (roll < 0.95) send({ ...freshRequest('BET'), wallet: UNKNOWN_WALLET });
    else ops.push({ type: 'worker' });
  }
  return ops.slice(0, count);
}

/** Lotes de 2 a 16 operações, cada um embaralhado: o que a fase concorrente dispara junto. Parte das operações é repetida no lote. */
export function toBatches(seed: number, ops: readonly Op[]): Op[][] {
  const random = mulberry32(seed ^ 0x5eed);
  const int = (max: number) => Math.floor(random() * max);
  const batches: Op[][] = [];
  // As wallets iniciais vêm primeiro, uma por lote: em paralelo, um par (jogador, moeda) repetido poderia vencer o original,
  // e sem elas os lotes seguintes só receberiam 404.
  const opening = ops.findIndex((op) => op.type !== 'wallet');
  const head = opening === -1 ? ops.length : opening;
  batches.push(...ops.slice(0, head).map((op) => [op]));
  for (let start = head; start < ops.length; ) {
    const batch = ops.slice(start, start + 2 + int(15));
    start += batch.length;
    for (const op of [...batch]) if (op.type === 'submit' && random() < 0.2) batch.push(op, op);
    for (let i = batch.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      [batch[i], batch[j]] = [batch[j]!, batch[i]!];
    }
    batches.push(batch);
  }
  return batches;
}
