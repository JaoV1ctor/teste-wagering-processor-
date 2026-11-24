/** Uma dependência sem a qual o serviço não consegue trabalhar. `check` rejeita se ela não responde; o `signal` cancela no timeout. */
export interface DependencyCheck {
  name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, 'up' | 'down'>;
}

export interface ReadinessOptions {
  /** Prazo de CADA verificação (todas rodam em paralelo, então é também o pior caso do conjunto). */
  timeoutMs: number;
  /** A causa da falha fica no log; a resposta HTTP só diz up/down, sem endereço nem mensagem do driver. Obrigatório: nada é engolido. */
  onFailure: (name: string, error: unknown) => void;
}

/**
 * Readiness (SPEC §8.4): o serviço está pronto se TODAS as dependências respondem dentro do prazo. Sem estado: cada chamada verifica de novo,
 * então a recuperação de uma dependência é vista na chamada seguinte. Uma verificação que ignora o `signal` e nunca resolve também vira `down`
 * no prazo (a corrida com o timeout é do checker, não da verificação).
 */
export class ReadinessChecker {
  constructor(
    private readonly dependencies: DependencyCheck[],
    private readonly options: ReadinessOptions,
  ) {}

  async run(): Promise<ReadinessResult> {
    const results = await Promise.all(this.dependencies.map((dependency) => this.runOne(dependency)));
    return { ready: results.every(([, state]) => state === 'up'), checks: Object.fromEntries(results) };
  }

  private async runOne({ name, check }: DependencyCheck): Promise<[string, 'up' | 'down']> {
    const { timeoutMs, onFailure } = this.options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`sem resposta em ${timeoutMs} ms`)), timeoutMs);
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    try {
      await Promise.race([check(controller.signal), expired]);
      return [name, 'up'];
    } catch (error) {
      onFailure(name, error);
      return [name, 'down'];
    } finally {
      clearTimeout(timer);
    }
  }
}
