/**
 * `bun run test:security`: roda a suíte de `test/security` e junta o que cada caso registrou em `security-results/report.md`.
 * Sai com o código da suíte: o relatório é gerado também quando algum caso falha.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

interface Category {
  number: number;
  title: string;
  rows: { name: string; expected: string; observed: string; result: string }[];
}

const DIRECTORY = 'security-results';
rmSync(DIRECTORY, { recursive: true, force: true });

const suite = Bun.spawn([process.execPath, 'test', 'test/security'], { stdout: 'inherit', stderr: 'inherit' });
const code = await suite.exited;

const categories = readdirSync(DIRECTORY)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(`${DIRECTORY}/${file}`, 'utf8')) as Category);
const results = categories.flatMap((category) => category.rows.map((row) => row.result));
const count = (result: string) => results.filter((value) => value === result).length;

const sections = categories.map((category) =>
  [
    `### ${category.number}. ${category.title}`,
    '',
    '| Caso | Esperado | Observado | Resultado |',
    '| --- | --- | --- | --- |',
    ...category.rows.map((row) => `| ${row.name} | ${row.expected} | ${row.observed} | ${row.result} |`),
  ].join('\n'));
const summary = `Execução de ${new Date().toISOString()}, Bun ${Bun.version}: ${results.length} casos em ${categories.length} categorias; ` +
  `${count('passou')} passaram, ${count('limitação confirmada')} confirmam limitações e ${count('FALHOU')} falharam.`;
writeFileSync(`${DIRECTORY}/report.md`, `${summary}\n\n${sections.join('\n\n')}\n`);
process.stdout.write(`[segurança] ${summary}\n[segurança] relatório: ${DIRECTORY}/report.md\n`);
process.exit(code);
