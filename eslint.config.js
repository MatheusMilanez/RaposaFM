import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Scripts k6 rodam no runtime próprio do k6 (Goja), não no Node —
    // __ENV, __VU e __ITER são globais dele, não do Node.
    files: ['scripts/load/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },
  prettierConfig,
];
