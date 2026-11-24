/** Lê variável obrigatória; falha cedo com mensagem clara (nunca valor default silencioso). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ausente: ${name} (copie .env.example para .env)`);
  return value;
}
