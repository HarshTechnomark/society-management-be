const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'error', // use the pino logger
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    // BR-07-47: only the audit archive may delete audit rows
    files: ['src/**/*.ts'],
    ignores: ['src/modules/platform-ops/platform-ops.audit-archive.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/DELETE\\s+FROM\\s+audit_logs/i]',
          message: 'Only platform-ops.audit-archive.ts may delete audit_logs rows (no-audit-delete)',
        },
        {
          selector: 'TemplateElement[value.raw=/DELETE\\s+FROM\\s+audit_logs/i]',
          message: 'Only platform-ops.audit-archive.ts may delete audit_logs rows (no-audit-delete)',
        },
      ],
    },
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
