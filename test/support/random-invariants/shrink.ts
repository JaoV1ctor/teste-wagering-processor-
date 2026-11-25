/**
 * Redução de uma sequência que falha (delta debugging): remove blocos cada vez menores enquanto a falha continuar. `fails` reexecuta a
 * sequência do zero. O resultado é 1-mínimo (retirar qualquer item isolado faz a falha sumir) se o orçamento de tentativas bastar.
 */
export async function shrink<T>(items: readonly T[], fails: (candidate: T[]) => Promise<boolean>, maxAttempts = 150): Promise<T[]> {
  let current = [...items];
  let attempts = 0;
  for (let size = Math.ceil(current.length / 2); size >= 1; ) {
    let removed = false;
    for (let start = 0; start < current.length && attempts < maxAttempts; ) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if (candidate.length === 0) {
        start += size;
        continue;
      }
      attempts += 1;
      if (await fails(candidate)) {
        current = candidate;
        removed = true;
      } else {
        start += size;
      }
    }
    if (attempts >= maxAttempts) break;
    // Com blocos de 1, repete até uma volta inteira sem remover nada.
    if (size === 1 && !removed) break;
    size = Math.max(1, Math.floor(size / 2));
  }
  return current;
}
