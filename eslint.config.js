import tseslint from 'typescript-eslint';

const MONEY_NAME = '/amount|balance|cents|money/i';
const MONEY_MESSAGE = 'Proibido number para dinheiro: use Money (bigint em centavos) e strings decimais nas bordas.';

/** Em `src/`, dinheiro nunca passa por ponto flutuante. Teste da regra: test/unit/money-lint.test.ts. */
const moneyIsNeverNumber = [
  { selector: "CallExpression[callee.name='parseFloat']", message: MONEY_MESSAGE },
  { selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']", message: MONEY_MESSAGE },
  { selector: "CallExpression[callee.name='Number']", message: MONEY_MESSAGE },
  { selector: "UnaryExpression[operator='+']", message: MONEY_MESSAGE },
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']", message: MONEY_MESSAGE },
  { selector: "CallExpression[callee.property.name='toFixed']", message: MONEY_MESSAGE },
  ...['TSPropertySignature', 'PropertyDefinition'].map((node) => ({
    selector: `${node}[key.name=${MONEY_NAME}] > TSTypeAnnotation > TSNumberKeyword`,
    message: MONEY_MESSAGE,
  })),
  { selector: `Identifier[name=${MONEY_NAME}] > TSTypeAnnotation > TSNumberKeyword`, message: MONEY_MESSAGE },
];

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/'] },
  ...tseslint.configs.recommended,
  // Corpo das respostas HTTP nos testes é JSON arbitrário: `any` só aqui.
  { files: ['test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['src/**/*.ts'], rules: { 'no-restricted-syntax': ['error', ...moneyIsNeverNumber] } },
  // Um único ponto de saída de log (src/infrastructure/observability/json-log.ts): nada de console.* na aplicação nem nos scripts.
  { files: ['src/**/*.ts', 'scripts/**/*.ts'], rules: { 'no-console': 'error' } },
);
