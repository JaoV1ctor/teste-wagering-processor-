// O apoio do teste de invariantes aleatórias (test/concurrency/random-invariants.test.ts): sem banco, só o gerador, o modelo e a redução.
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { ReferenceModel } from '../support/random-invariants/model';
import { CONCURRENT, DEFAULT_OPS, DEFAULT_SEEDS, generateOps, mulberry32, type Op, SEQUENTIAL, toBatches } from '../support/random-invariants/operations';
import { shrink } from '../support/random-invariants/shrink';

/** O que o modelo de referência espera de cada operação, incluindo as passadas do worker. */
function outcomes(ops: readonly Op[]): Set<string> {
  const model = new ReferenceModel();
  const seen = new Set<string>();
  const resolve = () => model.resolvePending().forEach((t) => seen.add(`worker:${t.failureCode ?? t.status}`));
  for (const op of ops) {
    if (op.type === 'worker') {
      resolve();
      continue;
    }
    const expected = model.apply(op);
    if (expected.outcome !== 'recorded') seen.add(expected.outcome);
    else seen.add(expected.replay ? 'replay' : (expected.transaction.failureCode ?? expected.transaction.status));
  }
  while (model.pending().length > 0) resolve();
  return seen;
}

describe('gerador', () => {
  test('mulberry32: mesma semente, mesma sequência em [0, 1)', () => {
    const [a, b] = [mulberry32(7), mulberry32(7)];
    const first = Array.from({ length: 1000 }, a);

    expect(Array.from({ length: 1000 }, b)).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test('a mesma semente gera as mesmas operações e os mesmos lotes; outra semente, outras', () => {
    const ops = generateOps(1, 200, CONCURRENT);

    expect(ops).toHaveLength(200);
    expect(generateOps(1, 200, CONCURRENT)).toEqual(ops);
    expect(toBatches(1, ops)).toEqual(toBatches(1, ops));
    expect(generateOps(2, 200, CONCURRENT)).not.toEqual(ops);
  });

  test('as sementes padrão exercitam todos os desfechos na fase sequencial', () => {
    const seen = new Set(DEFAULT_SEEDS.flatMap((seed) => [...outcomes(generateOps(seed, DEFAULT_OPS, SEQUENTIAL))]));
    const rejections = Object.values(FailureCode).filter((code) => code !== FailureCode.InternalPermanentError);
    const expected = [
      ...rejections, 'PROCESSED', 'PENDING_REFERENCE', 'worker:PROCESSED', 'worker:REFERENCE_NOT_FOUND', 'replay', 'conflict', 'invalid',
      'wallet-created', 'wallet-exists', 'wallet-not-found', 'duplicate-message', 'inbox-conflict',
    ];

    expect(expected.filter((outcome) => !seen.has(outcome) && !seen.has(`worker:${outcome}`))).toEqual([]);
  });

  test('as sementes padrão repetem chaves de idempotência entre provedores', () => {
    for (const seed of DEFAULT_SEEDS) {
      const submits = generateOps(seed, DEFAULT_OPS, SEQUENTIAL).filter((op) => op.type === 'submit');
      expect(submits.some((a) => submits.some((b) => a.key === b.key && a.request.provider !== b.request.provider))).toBe(true);
    }
  });
});

describe('redução da sequência que falha', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  test('sobram só os itens necessários, na ordem original', async () => {
    const minimal = await shrink(items, async (candidate) => [3, 41, 90].every((n) => candidate.includes(n)));

    expect(minimal).toEqual([3, 41, 90]);
  });

  test('respeita o limite de tentativas e devolve uma sequência que ainda falha', async () => {
    let attempts = 0;

    const reduced = await shrink(items, async (candidate) => {
      attempts += 1;
      return candidate.includes(50);
    }, 5);

    expect(attempts).toBe(5);
    expect(reduced).toContain(50);
  });
});
