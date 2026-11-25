/**
 * Executa `tasks` com no máximo `concurrency` em voo (laço fechado: a próxima só começa quando uma termina). Devolve os resultados na
 * ordem das tarefas. Uma tarefa que lança interrompe a execução: erro esperado deve virar resultado.
 */
export async function runPool<T>(concurrency: number, tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}
