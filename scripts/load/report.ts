/** Tabelas em Markdown a partir dos resultados. Duas casas decimais em todo número medido; "—" quando não há medida. */
import type { LoadConfig } from './config';
import type { Repetition, ScenarioResult } from './scenarios';
import { type Distribution, variation } from './stats';

const number = (value: number | undefined): string => (value === undefined || Number.isNaN(value) ? '—' : value.toFixed(2));
/** Contagens: sem casas decimais, salvo a mediana de um número par de repetições (x,5). */
const counted = (value: number | undefined): string => (value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(2));

const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');

interface Column {
  header: string;
  value(repetition: Repetition): number | undefined;
  format?: (value: number | undefined) => string;
}

/** Uma linha por repetição, mais mediana, mínimo, máximo e amplitude relativa entre elas. */
function summarized(columns: Column[], repetitions: Repetition[]): string {
  const cell = (column: Column, value: number | undefined) => (column.format ?? number)(value);
  const rows = repetitions.map((repetition, index) => [String(index + 1), ...columns.map((column) => cell(column, column.value(repetition)))]);
  const across = (pick: (summary: ReturnType<typeof variation>) => number | undefined, percent = false) =>
    columns.map((column) => {
      const values = repetitions.map((repetition) => column.value(repetition)).filter((value): value is number => value !== undefined);
      return values.length === 0 ? '—' : (percent ? number : (column.format ?? number))(pick(variation(values)));
    });
  rows.push(['**mediana**', ...across((s) => s.median)]);
  rows.push(['mínimo', ...across((s) => s.min)]);
  rows.push(['máximo', ...across((s) => s.max)]);
  rows.push(['amplitude / mediana (%)', ...across((s) => s.spreadPercent, true)]);
  return table(['Repetição', ...columns.map((column) => column.header)], rows);
}

const percentiles = (label: string, pick: (r: Repetition) => Distribution | undefined): Column[] =>
  (['p50', 'p95', 'p99', 'max'] as const).map((key) => ({ header: `${label} ${key} (ms)`, value: (r) => pick(r)?.[key] }));

const STATUS_ORDER = ['201', '202', '422', '400', '409', '500', '503', 'timeout', 'network'];

function statusTable(scenario: ScenarioResult): string {
  const seen = new Set(scenario.repetitions.flatMap((r) => Object.keys(r.statuses)));
  const keys = [...STATUS_ORDER.filter((key) => seen.has(key)), ...[...seen].filter((key) => !STATUS_ORDER.includes(key)).sort()];
  const success = new Set(['201', '202', '422', 'PROCESSED', 'REJECTED', 'PENDING_REFERENCE']);
  const rows = scenario.repetitions.map((repetition, index) => {
    const errors = Object.entries(repetition.statuses).filter(([key]) => !success.has(key)).reduce((sum, [, n]) => sum + n, 0);
    return [String(index + 1), ...keys.map((key) => String(repetition.statuses[key] ?? 0)), `${number((errors / repetition.sent) * 100)}%`,
      Object.entries(repetition.kinds).sort().map(([kind, n]) => `${kind} ${n}`).join(', ')];
  });
  return table(['Repetição', ...keys, 'Taxa de erro', 'Operações enviadas'], rows);
}

function scenarioSection(scenario: ScenarioResult): string {
  const isQueue = scenario.id === 'C';
  const speed: Column[] = isQueue
    ? [
        { header: 'Mensagens', value: (r) => r.sent, format: counted },
        { header: 'Enfileiramento (s)', value: (r) => r.queue?.enqueueSeconds },
        { header: 'Drenagem: 1º ao último processamento (s)', value: (r) => r.queue?.processingWindowSeconds },
        { header: 'Início da subida das instâncias até o fim (s)', value: (r) => r.queue?.spawnToDoneSeconds },
        { header: 'msg/s', value: (r) => r.throughput },
        { header: 'Processamento médio por mensagem (ms)', value: (r) => (r.counters.processingCount ? (r.counters.processingSeconds / r.counters.processingCount) * 1000 : undefined) },
      ]
    : [
        { header: 'Requisições', value: (r) => r.sent, format: counted },
        { header: 'Duração (s)', value: (r) => r.durationSeconds },
        { header: 'req/s', value: (r) => r.throughput },
        ...percentiles('Latência', (r) => r.latency),
      ];
  const concurrency: Column[] = [
    { header: 'HTTP 503', value: (r) => (isQueue ? undefined : (r.statuses['503'] ?? 0)), format: counted },
    { header: 'Conflitos de lock (40P01, 40001, 55P03)', value: (r) => r.counters.lockConflicts, format: counted },
    { header: 'Retries no banco', value: (r) => r.counters.retriesDatabase, format: counted },
    { header: 'Retries na fila', value: (r) => r.counters.retriesQueue, format: counted },
    { header: 'Mensagens à DLQ', value: (r) => r.counters.deadLettered, format: counted },
    { header: 'Deadlocks (pg_stat_database)', value: (r) => r.counters.deadlocks, format: counted },
    { header: 'Espera média pelo lock da wallet (ms)', value: (r) => (r.counters.lockWaitCount ? (r.counters.lockWaitSeconds / r.counters.lockWaitCount) * 1000 : undefined) },
  ];
  const outbox: Column[] = [
    { header: 'Eventos', value: (r) => r.outboxLag?.count, format: counted },
    { header: 'Lag p50 (ms)', value: (r) => r.outboxLag?.p50 },
    { header: 'Lag p95 (ms)', value: (r) => r.outboxLag?.p95 },
    { header: 'Lag máx (ms)', value: (r) => r.outboxLag?.max },
    { header: 'Publicação restante após a carga (s)', value: (r) => r.outboxDrainSeconds },
  ];

  const parts = [
    `### Cenário ${scenario.id}. ${scenario.title}`,
    '#### Vazão' + (isQueue ? ' e drenagem' : ' e latência'), summarized(speed, scenario.repetitions),
    isQueue ? '#### Estado final das transações' : '#### Respostas por status', statusTable(scenario),
    '#### Concorrência', summarized(concurrency, scenario.repetitions),
    '#### Outbox', summarized(outbox, scenario.repetitions),
  ];
  if (scenario.id === 'D') {
    parts.push('#### Efeito dos reenvios', summarized([
      { header: 'Reenvios', value: (r) => r.replays?.sent, format: counted },
      { header: 'Respondidos como replay', value: (r) => r.replays?.answeredAsReplay, format: counted },
      { header: 'Duplicatas contadas pela aplicação', value: (r) => r.counters.duplicates, format: counted },
      ...percentiles('Original', (r) => r.replays?.original),
      ...percentiles('Replay', (r) => r.replays?.replay),
    ], scenario.repetitions));
  }
  const { checks, events, ok } = scenario.invariants;
  parts.push(
    `#### Invariantes: ${ok ? 'TODAS PASSARAM' : 'FALHARAM (os números deste cenário NÃO valem)'}`,
    table(['Verificação', 'Observado', 'Esperado'], checks.map((check) => [check.name, String(check.observed), String(check.expected)])),
    `Eventos: ${events.inOutbox} no outbox; ${events.received} entregas recebidas da fila; ${events.unique} eventIds distintos; ` +
      `duplicatas brutas: ${events.rawDuplicates} (${number(events.received ? (events.rawDuplicates / events.received) * 100 : 0)}% das entregas).`,
  );
  return parts.join('\n\n');
}

export function renderReport(environment: [string, string][], config: LoadConfig, scenarios: ScenarioResult[], totalSeconds: number, startedAt: Date): string {
  return [
    `Execução iniciada em ${startedAt.toISOString()}, duração total ${number(totalSeconds)} s.`,
    '### Ambiente', table(['Item', 'Valor'], environment.map(([item, value]) => [item, value])),
    '### Parâmetros', table(['Parâmetro', 'Valor'], Object.entries(config).map(([key, value]) => [`\`${key}\``, Array.isArray(value) ? value.join(', ') : String(value)])),
    ...scenarios.map(scenarioSection),
  ].join('\n\n') + '\n';
}
