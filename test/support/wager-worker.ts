// Processo FILHO do cenário #4: sobe uma instância completa da aplicação (próprio pool de conexões ao Postgres) e dispara,
// em paralelo, as requisições recebidas por stdin. Imprime `RESULT:<json>` com status e corpo de cada resposta.
import { startApi } from './app';
import { submit } from './wager';

interface Job {
  payload: unknown;
  key: string;
}

const jobs = JSON.parse(await Bun.stdin.text()) as Job[];
const api = await startApi();
const results = await Promise.all(
  jobs.map(async ({ payload, key }) => {
    const res = await submit(api, payload, key);
    return { status: res.status, body: res.body };
  }),
);
await api.close();
process.stdout.write(`RESULT:${JSON.stringify(results)}\n`);
process.exit(0);
