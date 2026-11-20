import tseslint from 'typescript-eslint';
export default [
  { ignores: ['.next/**', 'node_modules/**', 'data/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'] },
  ...tseslint.configs.recommended,
];
