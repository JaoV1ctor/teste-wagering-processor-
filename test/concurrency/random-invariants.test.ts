// Invariantes sob operações aleatórias com semente fixa, contra PostgreSQL e MiniStack REAIS. Para cada semente: uma fase sequencial,
// comparada operação a operação com um modelo de referência, e uma concorrente, em lotes, que só exige o contrato e as invariantes.
// INVARIANT_SEED (lista separada por vírgula) e INVARIANT_OPS (operações por fase) mudam a execução. Na falha, imprime a semente e a
// menor sequência que a reproduz.
import { afterAll, describe, spyOn, test } from 'bun:test';
import { optionalPositiveInt } from '../../src/infrastructure/env';
import { CONCURRENT, DEFAULT_OPS, DEFAULT_SEEDS, generateOps, type Op, SEQUENTIAL, toBatches } from '../support/random-invariants/operations';
import { PhaseFailure, type PhaseResult, runConcurrent, runSequential } from '../support/random-invariants/phases';
import { shrink } from '../support/random-invariants/shrink';

const seeds = process.env['INVARIANT_SEED']?.split(',').map((text) => {
  if (!/^\d+$/.test(text.trim())) throw new Error(`INVARIANT_SEED inválida: "${text}"`);
  return Number.parseInt(text, 10);
}) ?? DEFAULT_SEEDS;
const count = optionalPositiveInt('INVARIANT_OPS', DEFAULT_OPS);

/** Cala o log JSON das aplicações do teste: milhares de linhas esconderiam o resumo e a sequência que falhou. */
const muted = [process.stdout, process.stderr].map((stream) => {
  const write = stream.write.bind(stream);
  return spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array) => String(chunk).startsWith('{"level"') || write(chunk)) as typeof stream.write);
});
afterAll(() => muted.forEach((spy) => spy.mockRestore()));

const kindOf = (error: unknown): string => (error instanceof PhaseFailure ? error.kind : `erro: ${String(error).slice(0, 80)}`);

/** Roda a fase; se falhar, reduz a sequência e imprime o necessário para reproduzir antes de repassar a falha. */
async function check<T>(phase: string, seed: number, items: T[], run: (items: T[]) => Promise<PhaseResult>, attempts: { runs: number; shrink: number }): Promise<void> {
  let result: PhaseResult;
  try {
    result = await run(items);
  } catch (error) {
    const report = (text: string) => process.stderr.write(`[invariantes] ${text}\n`);
    report(`FALHA seed=${seed} fase=${phase} operações=${count}: ${String(error)}`);
    report(`reproduzir: INVARIANT_SEED=${seed} INVARIANT_OPS=${count} bun test test/concurrency/random-invariants.test.ts`);
    report('reduzindo a sequência...');
    const minimal = await shrink(items, async (candidate) => {
      // A ordem da fase concorrente varia: uma candidata é executada algumas vezes antes de ser descartada.
      for (let i = 0; i < attempts.runs; i += 1) {
        try {
          await run(candidate);
        } catch (other) {
          if (kindOf(other) === kindOf(error)) return true;
        }
      }
      return false;
    }, attempts.shrink);
    report(`sequência mínima (${minimal.length} de ${items.length}):`);
    minimal.forEach((item, index) => report(`  ${index + 1}. ${JSON.stringify(item)}`));
    throw error;
  }
  const tally = Object.entries(result.tally).sort().map(([label, n]) => `${label}=${n}`).join(' ');
  process.stdout.write(`[invariantes] seed=${seed} fase=${phase} operações=${items.length} digest=${result.digest} ${tally}\n`);
}

describe.each(seeds)('operações aleatórias, semente %d', (seed) => {
  test('sequencial: cada resposta e o banco batem com o modelo de referência; invariantes ao final', async () => {
    await check('sequencial', seed, generateOps(seed, count, SEQUENTIAL), runSequential, { runs: 1, shrink: 150 });
  }, 600_000);

  test('concorrente: lotes simultâneos em duas instâncias, HTTP, fila e worker; invariantes ao final', async () => {
    // Cada item leva o número do lote, para a redução preservar quem rodava junto.
    const items = toBatches(seed, generateOps(seed, count, CONCURRENT)).flatMap((batch, lot) => batch.map((op) => ({ lot, op })));
    const run = (chosen: { lot: number; op: Op }[]) => {
      const lots = new Map<number, Op[]>();
      for (const { lot, op } of chosen) lots.set(lot, [...(lots.get(lot) ?? []), op]);
      return runConcurrent([...lots.values()]);
    };
    await check('concorrente', seed, items, run, { runs: 3, shrink: 60 });
  }, 600_000);
});
