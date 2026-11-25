/** Descrição da máquina e das versões, lida na hora da execução: o relatório não depende de memória de ninguém. */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import pg from 'pg';
import { requireEnv } from '../../src/infrastructure/env';

const UNAVAILABLE = 'não disponível';

function output(command: string[]): string {
  try {
    const result = Bun.spawnSync(command);
    return result.success ? result.stdout.toString().trim() : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export async function describeEnvironment(): Promise<[string, string][]> {
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
  await client.connect();
  let postgres: string;
  let settings: string;
  try {
    postgres = (await client.query<{ v: string }>('select version() as v')).rows[0]!.v;
    const { rows } = await client.query<{ s: string }>(
      `select string_agg(name || '=' || current_setting(name), ', ' order by name) as s from pg_settings
        where name in ('max_connections', 'shared_buffers', 'synchronous_commit', 'fsync', 'work_mem')`);
    settings = rows[0]!.s;
  } finally {
    await client.end();
  }
  const images = [...readFileSync('docker-compose.yml', 'utf8').matchAll(/^\s+image:\s*(\S+)/gm)].map((match) => match[1]).join(', ');
  const cpus = os.cpus();
  const changed = output(['git', 'status', '--porcelain', '--untracked-files=no']);
  return [
    ['Sistema operacional', `${os.version()} (${os.release()}), ${os.arch()}`],
    ['CPU', `${cpus[0]?.model.trim() ?? UNAVAILABLE}, ${cpus.length} processadores lógicos`],
    ['RAM da máquina', `${(os.totalmem() / 1024 ** 3).toFixed(2)} GiB`],
    ['VM do Docker (CPUs, memória em bytes)', output(['docker', 'info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes, {{.OperatingSystem}} {{.ServerVersion}}'])],
    ['Bun', Bun.version],
    ['PostgreSQL', postgres],
    ['Configuração do PostgreSQL', settings],
    ['Imagens do docker-compose.yml (sem limite de CPU ou memória por container)', images],
    ['Commit medido', `${output(['git', 'rev-parse', '--short', 'HEAD'])}${changed === '' ? '' : ' (com alterações não commitadas)'}`],
  ];
}
