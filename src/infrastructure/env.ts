/** Configuração inválida no boot. A mensagem cita nomes de variáveis e limites, nunca o valor lido: por isso ela pode ir para o log. */
export class ConfigurationError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

/** Lê variável obrigatória; falha cedo com mensagem clara (nunca valor default silencioso). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`Variável de ambiente ausente: ${name} (copie .env.example para .env)`);
  return value;
}

/** Inteiro positivo opcional; valor presente porém inválido falha cedo (nunca cai em silêncio no padrão). */
export function optionalPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new ConfigurationError(`Variável de ambiente inválida: ${name} deve ser inteiro positivo`);
  return Number.parseInt(raw, 10);
}
