import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'reference/', 'coverage/'] },
  ...tseslint.configs.recommended,
);
