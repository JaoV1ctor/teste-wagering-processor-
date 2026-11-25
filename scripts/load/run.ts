/**
 * `bun run test:load` (ou `bun run test:load --smoke`). Parâmetros: variáveis `LOAD_*` (ver `config.ts` e docs/LOAD_TEST.md).
 * Grava `load-results/<execução>/report.md`, `results.json` e `instances-stderr.log`. Sai com código 1 se alguma invariante falhar.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { loadConfig } from './config';
import { describeEnvironment } from './environment';
import { renderReport } from './report';
import { type Context, type ScenarioResult, SCENARIOS } from './scenarios';
import { assertLocalInfrastructure } from './stack';

const progress = (message: string): void => void process.stdout.write(`[carga] ${message}\n`);

const config = loadConfig(process.env, process.argv.slice(2));
assertLocalInfrastructure();

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/\D/g, '').slice(0, 14);
const directory = `load-results/${runId}`;
mkdirSync(directory, { recursive: true });
const errorLog = `${directory}/instances-stderr.log`;
appendFileSync(errorLog, '');

const client = createSqsClient();
const context: Context = { config, client, runId, errorLog, progress };
const environment = await describeEnvironment();
const results: ScenarioResult[] = [];
const started = Bun.nanoseconds();
try {
  progress(`perfil ${config.profile}, cenários ${config.scenarios.join(', ')}, ${config.instances} instância(s); saída em ${directory}`);
  for (const id of config.scenarios) results.push(await SCENARIOS[id](context));
} finally {
  client.destroy();
}
const totalSeconds = (Bun.nanoseconds() - started) / 1e9;

writeFileSync(`${directory}/results.json`, JSON.stringify({ startedAt, totalSeconds, environment, config, scenarios: results }, null, 2));
writeFileSync(`${directory}/report.md`, renderReport(environment, config, results, totalSeconds, startedAt));

const failed = results.filter((result) => !result.invariants.ok);
for (const result of failed) {
  for (const check of result.invariants.checks.filter((c) => c.observed !== c.expected)) {
    progress(`${result.id}: INVARIANTE FALHOU: ${check.name}: observado ${check.observed}, esperado ${check.expected}`);
  }
}
progress(`${totalSeconds.toFixed(1)} s; invariantes: ${failed.length === 0 ? 'todas passaram' : `falharam em ${failed.map((r) => r.id).join(', ')}`}`);
progress(`relatório: ${directory}/report.md`);
process.exit(failed.length === 0 ? 0 : 1);
