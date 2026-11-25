// As duas fases. Sequencial: cada resposta e o estado do banco são comparados com o modelo de referência. Concorrente: a ordem não é
// previsível, então só se exigem respostas dentro do contrato, a mesma resposta para a mesma transação e as invariantes.
import { createHash } from 'node:crypto';
import { violations } from './invariants';
import { type Expected, type ModelTransaction, ReferenceModel } from './model';
import { formatCents, type Op, type SubmitOp } from './operations';
import { type HttpReply, type QueueReply, World } from './world';

/** `kind` identifica o tipo da falha: a redução só aceita uma sequência menor que falhe do mesmo jeito. */
export class PhaseFailure extends Error {
  constructor(readonly kind: string, detail: string) {
    super(`${kind}: ${detail}`);
  }
}

export interface PhaseResult {
  /** Quantas vezes cada desfecho ocorreu: mostra o que a execução exercitou. */
  tally: Record<string, number>;
  /** Resumo do que foi observado, sem ids do servidor. Na fase sequencial, a mesma semente dá o mesmo resumo. */
  digest: string;
}

const HTTP_STATUS = { PROCESSED: 201, PENDING_REFERENCE: 202, REJECTED: 422 } as const;
const DISPOSITION: Partial<Record<Expected['outcome'], string>> = {
  invalid: 'MALFORMED_MESSAGE', conflict: 'IDEMPOTENCY_CONFLICT', 'wallet-not-found': 'WALLET_NOT_FOUND', 'inbox-conflict': 'INBOX_PAYLOAD_CONFLICT',
};
const REFUSAL: Partial<Record<Expected['outcome'], number>> = { invalid: 400, conflict: 409, 'wallet-not-found': 404 };

const show = (value: unknown): string => JSON.stringify(value);
const sha = (lines: string[]): string => createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);

function expectSame(kind: string, observed: unknown, expected: unknown): void {
  if (!Bun.deepEquals(observed, expected, true)) throw new PhaseFailure(kind, `observado ${show(observed)}, esperado ${show(expected)}`);
}

async function expectInvariants(world: World): Promise<void> {
  if (world.workerErrors.length > 0) throw new PhaseFailure('erro no worker', world.workerErrors[0]!);
  const found = await violations(world.probe);
  if (found.length > 0) throw new PhaseFailure(`invariante "${found[0]!.split(':')[0]}"`, found.join('; '));
}

async function withWorld<T>(instances: number, run: (world: World) => Promise<T>): Promise<T> {
  const world = await World.create(instances);
  try {
    return await run(world);
  } finally {
    await world.close();
  }
}

export function runSequential(ops: readonly Op[]): Promise<PhaseResult> {
  return withWorld(1, async (world) => {
    const model = new ReferenceModel();
    const ids = new Map<ModelTransaction, string>();
    const tally: Record<string, number> = {};
    const trace: string[] = [];
    const count = (label: string) => {
      tally[label] = (tally[label] ?? 0) + 1;
      trace.push(label);
    };

    const checkRow = async (transaction: ModelTransaction): Promise<void> => {
      const { provider, externalId } = transaction.request;
      const row = await world.transaction(provider, externalId);
      expectSame('transação divergente do modelo',
        row && { status: row.status, failureCode: row.failure_code, observed: row.observed_balance },
        { status: transaction.status, failureCode: transaction.failureCode ?? null, observed: transaction.observed === null ? null : formatCents(transaction.observed) });
    };
    const checkState = async (): Promise<void> => {
      const expected = new Map([...model.wallets].map(([alias, w]) => [alias, { balance: formatCents(w.balance), entries: w.entries }]));
      const observed = await world.walletStates();
      expectSame('saldo ou ledger divergente do modelo', Object.fromEntries(observed), Object.fromEntries(expected));
      expectSame('quantidade de transações divergente do modelo', await world.submittedCount(), model.byExternalId.size);
    };
    const workerStep = async (): Promise<void> => {
      const pending = model.resolvePending();
      for (const { request } of pending) await world.reprocess(request.provider, request.externalId);
      for (const transaction of pending) {
        await checkRow(transaction);
        count(`worker:${transaction.failureCode ?? transaction.status}`);
      }
    };

    const submit = async (op: SubmitOp): Promise<void> => {
      const expected = model.apply(op);
      const reply = await world.submit(op);
      const label = expected.outcome === 'recorded'
        ? `${expected.replay ? 'replay:' : ''}${expected.transaction.failureCode ?? expected.transaction.status}`
        : expected.outcome;
      count(`${op.via}:${label}`);

      if (op.via === 'sqs') {
        expectSame('destino da mensagem divergente do modelo', (reply as QueueReply).disposition, DISPOSITION[expected.outcome] ?? 'ack');
        if (expected.outcome === 'recorded') await checkRow(expected.transaction);
        return;
      }
      const { status, body } = reply as HttpReply;
      if (expected.outcome !== 'recorded') {
        expectSame('status HTTP divergente do modelo', status, REFUSAL[expected.outcome]);
        return;
      }
      const { transaction, replay } = expected;
      const id = ids.get(transaction) ?? (await world.transaction(transaction.request.provider, transaction.request.externalId))?.id;
      if (id !== undefined) ids.set(transaction, id);
      expectSame('status HTTP divergente do modelo', status, HTTP_STATUS[transaction.status]);
      // O saldo da resposta é sempre o da wallet, na moeda dela, mesmo quando o pedido veio em outra.
      const currency = model.wallets.get(transaction.request.wallet)!.currency;
      expectSame('corpo da resposta divergente do modelo', body, {
        transactionId: id, status: transaction.status, idempotentReplay: replay,
        balance: transaction.observed === null ? null : { amount: formatCents(transaction.observed), currency },
        ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
      });
    };

    for (const op of ops) {
      if (op.type === 'worker') await workerStep();
      else if (op.type === 'submit') await submit(op);
      else {
        const expected = model.apply(op);
        count(expected.outcome);
        expectSame('criação de wallet divergente do modelo', (await world.openWallet(op)).status, expected.outcome === 'wallet-created' ? 201 : 409);
      }
      await checkState();
    }
    // Fim da fase: o worker esgota o que ainda espera referência.
    while (model.pending().length > 0) await workerStep();
    await checkState();
    expectSame('pendências restantes', await world.pendingCount(), 0);
    await expectInvariants(world);
    for (const [alias, { balance, entries }] of await world.walletStates()) trace.push(`${alias} ${balance} ${entries}`);
    return { tally, digest: sha(trace) };
  });
}

/** Dispara cada lote junto, alternando entre duas instâncias da aplicação, com dois consumidores da mesma fila. */
export function runConcurrent(batches: readonly (readonly Op[])[]): Promise<PhaseResult> {
  return withWorld(2, async (world) => {
    const tally: Record<string, number> = {};
    const count = (label: string) => { tally[label] = (tally[label] ?? 0) + 1; };
    /** Primeira resposta definitiva de cada transação e a transação que cada chave devolveu. */
    const final = new Map<string, string>();
    const byKey = new Map<string, string>();

    const run = async (op: Op, instance: number): Promise<void> => {
      if (op.type === 'worker') return world.workerPass();
      if (op.type === 'wallet') {
        const { status } = await world.openWallet(op, instance);
        count(`wallet:${status}`);
        if (status !== 201 && status !== 409) throw new PhaseFailure('status fora do contrato', `criação de wallet respondeu ${status}`);
        return;
      }
      const reply = await world.submit(op, instance);
      if ('disposition' in reply) {
        count(`sqs:${reply.disposition}`);
        const allowed = op.defect === undefined ? ['ack', 'IDEMPOTENCY_CONFLICT', 'WALLET_NOT_FOUND', 'INBOX_PAYLOAD_CONFLICT'] : ['MALFORMED_MESSAGE'];
        if (!allowed.includes(reply.disposition)) throw new PhaseFailure('destino de mensagem fora do contrato', `${reply.disposition} em ${show(op)}`);
        return;
      }
      const { status, body } = reply;
      count(`http:${status}`);
      const allowed = op.defect === undefined ? [201, 202, 422, 409, 404, 503] : [400];
      if (!allowed.includes(status)) throw new PhaseFailure('status fora do contrato', `${status} ${show(body)} em ${show(op)}`);
      if (body.transactionId === undefined) return;

      const key = show([op.request.provider, op.key]);
      expectSame('a mesma chave devolveu outra transação', body.transactionId, byKey.get(key) ?? body.transactionId);
      byKey.set(key, body.transactionId);
      if (body.status === 'PENDING_REFERENCE') return;
      const answer = show([status, body.status, body.failureCode ?? null, body.balance]);
      expectSame('respostas diferentes para a mesma transação', answer, final.get(body.transactionId) ?? answer);
      final.set(body.transactionId, answer);
    };

    for (const batch of batches) {
      // Espera o lote inteiro terminar antes de falhar, para não fechar o ambiente com operações em andamento.
      const results = await Promise.allSettled(batch.map(run));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    for (let pass = 0; (await world.pendingCount()) > 0 && pass < 20; pass += 1) await Promise.all([world.workerPass(), world.workerPass()]);
    expectSame('pendências restantes', await world.pendingCount(), 0);
    await expectInvariants(world);
    const states = [...(await world.walletStates())].map(([alias, { balance, entries }]) => `${alias} ${balance} ${entries}`);
    return { tally, digest: sha(states) };
  });
}
