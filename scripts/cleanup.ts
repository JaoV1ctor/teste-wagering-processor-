/**
 * Liberação de recursos dos ambientes descartáveis (testes e carga): cada recurso registra como se desfazer assim que passa a existir,
 * e a liberação roda na ordem inversa, mesmo que o setup tenha parado no meio.
 */
import { DeleteQueueCommand, ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';

type Step = () => unknown;

export class Cleanup {
  private readonly steps: Step[] = [];

  defer(step: Step): void {
    this.steps.push(step);
  }

  /** Tenta todos os passos, do último para o primeiro, e só então relata os que falharam. Chamar de novo não repete nada. */
  async run(): Promise<void> {
    const failures: unknown[] = [];
    for (let step = this.steps.pop(); step; step = this.steps.pop()) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} passo(s) da limpeza falharam: ${failures.map(String).join('; ')}`);
  }
}

/** Executa o setup; se ele falhar, libera o que já tinha sido registrado e propaga o erro original. */
export async function releaseOnFailure<T>(cleanup: Cleanup, setup: () => Promise<T>): Promise<T> {
  try {
    return await setup();
  } catch (error) {
    try {
      await cleanup.run();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `o setup falhou (${String(error)}) e a limpeza também (${String(cleanupError)})`);
    }
    throw error;
  }
}

/** Apaga todas as filas cujo nome começa com `prefix`: alcança também as de uma criação que parou no meio. */
export async function deleteQueuesWithPrefix(client: SQSClient, prefix: string): Promise<void> {
  // Sem prefixo, a listagem devolveria também as filas de desenvolvimento.
  if (prefix === '') throw new Error('prefixo vazio: a limpeza não apaga filas sem prefixo');
  const { QueueUrls = [] } = await client.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
  const cleanup = new Cleanup();
  for (const url of QueueUrls) cleanup.defer(() => client.send(new DeleteQueueCommand({ QueueUrl: url })));
  await cleanup.run();
}
