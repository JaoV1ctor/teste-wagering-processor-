/**
 * Log JSON de uma linha (SPEC §8.4). Nunca recebe payload completo nem segredo: só ids e o nome/mensagem do erro.
 * Mínimo da Fase 3 para o worker não falhar em silêncio; a Fase 6 acrescenta correlationId e métricas.
 */
export function logJson(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ level, time: new Date().toISOString(), message, ...fields })}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
}

export function describeError(error: unknown): { errorName: string; errorMessage: string } {
  return error instanceof Error ? { errorName: error.name, errorMessage: error.message } : { errorName: typeof error, errorMessage: String(error) };
}
