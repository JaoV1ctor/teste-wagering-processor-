// Leitura do formato texto do Prometheus (`GET /metrics`) para os testes: nomes, labels e valores.
import type { Api } from './app';

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface MetricsPage {
  text: string;
  samples: Sample[];
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) throw new Error(`linha fora do formato Prometheus: ${line}`);
    const labels: Record<string, string> = {};
    for (const [, key = '', value = ''] of (match[2] ?? '').matchAll(LABEL)) labels[key] = value;
    samples.push({ name: match[1] ?? '', labels, value: Number.parseFloat(match[3] ?? 'NaN') });
  }
  return samples;
}

export async function scrape(api: Api): Promise<MetricsPage> {
  const res = await fetch(`${api.url}/metrics`);
  if (res.status !== 200) throw new Error(`GET /metrics respondeu ${res.status}`);
  const text = await res.text();
  return { text, samples: parseMetrics(text) };
}

/** Soma dos valores das amostras de `name` cujos labels contêm `labels`; 0 se não houver amostra (contador ainda não incrementado). */
export function total(page: MetricsPage, name: string, labels: Record<string, string> = {}): number {
  return page.samples
    .filter((s) => s.name === name && Object.entries(labels).every(([key, value]) => s.labels[key] === value))
    .reduce((sum, s) => sum + s.value, 0);
}
