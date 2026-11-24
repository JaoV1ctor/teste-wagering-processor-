// Captura o que a aplicação escreve em stdout/stderr (o único destino do logger JSON), para inspecionar o formato e o conteúdo.
export interface CapturedLine {
  raw: string;
  json: Record<string, unknown>;
}

export interface LogCapture {
  lines(): CapturedLine[];
  /** Só as linhas com `message === name`. */
  named(name: string): Record<string, unknown>[];
  restore(): void;
}

export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;

  const lines = (): CapturedLine[] =>
    chunks.join('').split('\n').filter((raw) => raw !== '').map((raw) => ({ raw, json: JSON.parse(raw) as Record<string, unknown> }));
  return {
    lines,
    named: (name) => lines().map((line) => line.json).filter((json) => json['message'] === name),
    restore() {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    },
  };
}
