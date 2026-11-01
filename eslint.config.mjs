import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'reference/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error'
    }
  },
  {
    files: ['src/main/logger.ts', 'tests/**', 'e2e/**', 'scripts/**'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } }
  },
  {
    files: ['tests/fixtures/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { process: 'readonly', require: 'readonly', setInterval: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
