// Processo FILHO do cenário #4: sobe uma instância completa da aplicação (próprio pool de conexões ao Postgres). Recebe por stdin uma linha
// com as requisições, imprime `READY` quando a instância está no ar, espera a linha `GO` (barreira: os processos disparam juntos) e as envia
// em paralelo. Imprime `RESULT:<json>` com status e corpo de cada resposta.
import { createInterface } from 'node:readline';
import { startApi } from './app';
import { submit } from './wager';

interface Job {
  payload: unknown;
  key: string;
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const nextLine = async (): Promise<string> => {
  const { value, done } = await lines.next();
  if (done) throw new Error('stdin fechou antes da linha esperada');
  return value;
};

const jobs = JSON.parse(await nextLine()) as Job[];
const api = await startApi();
process.stdout.write('READY\n');
if ((await nextLine()) !== 'GO') throw new Error('esperava GO');
const results = await Promise.all(
  jobs.map(async ({ payload, key }) => {
    const res = await submit(api, payload, key);
    return { status: res.status, body: res.body };
  }),
);
await api.close();
process.stdout.write(`RESULT:${JSON.stringify(results)}\n`);
process.exit(0);
