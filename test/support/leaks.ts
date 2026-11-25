// Detector de detalhe interno em respostas da suíte de segurança. Auto-teste em test/unit/leak-detector.test.ts.

/** Credencial falsa e única dada à aplicação isolada: se aparecer em resposta ou log, é vazamento. */
export const SECRET_CANARY = 'sec-canary-aws-secret-8f2c1d';

/** Marcas conhecidas de detalhe interno. A lista é finita: o que não casa com nenhuma passa. */
const LEAKS: [string, RegExp][] = [
  ['stack trace', /\n\s+at |\bat [\w.<>]+ \(|node_modules|"stack"/i],
  ['SQL', /\bselect\b[\s\S]{0,200}\bfrom\b|\binsert into\b|\bupdate\s+"?\w+"?\s+set\b/i],
  ['erro do banco ou do driver', /relation "|column "|violates|SQLSTATE|syntax error|invalid byte sequence|invalid input syntax|DriverException|MikroORM|\bpg_|duplicate key/i],
  ['string de conexão ou credencial', /postgres(ql)?:\/\/|:wager@|sec-canary/i],
  ['caminho do servidor', /[A-Z]:\\|\/src\/(application|domain|infrastructure|interface)\//],
];

/** Se o texto é JSON, olha também cada chave e valor já decodificados: no JSON cru, uma quebra de linha é `\n` escrito por extenso. */
export function leaksIn(text: string): string[] {
  const texts = [text, ...stringsIn(parseJson(text))];
  return LEAKS.filter(([, pattern]) => texts.some((candidate) => pattern.test(candidate))).map(([name]) => name);
}

/**
 * Vazamentos em uma resposta. `sent` é o valor enviado, que a validação pode repetir: só é descontado onde a API o repete, entre aspas em
 * `details[].message` de um `VALIDATION_ERROR`. O resto do corpo é examinado como veio.
 */
export function leaksInReply(text: string, sent?: string): string[] {
  const body = sent === undefined ? undefined : parseJson(text);
  if (!isValidationError(body)) return leaksIn(text);
  const details = body.details.map((detail) =>
    isRecord(detail) && typeof detail['message'] === 'string'
      ? { ...detail, message: detail['message'].replaceAll(`"${sent}"`, '"(eco)"') }
      : detail);
  return leaksIn(JSON.stringify({ ...body, details }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isValidationError(body: unknown): body is Record<string, unknown> & { details: unknown[] } {
  return isRecord(body) && body['code'] === 'VALIDATION_ERROR' && Array.isArray(body['details']);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined; // não é JSON: vale só o texto cru
    throw error;
  }
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return isRecord(value) ? Object.entries(value).flatMap(([key, member]) => [key, ...stringsIn(member)]) : [];
}
