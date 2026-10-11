import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', structuredClone: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', WebSocket: 'readonly', Intl: 'readonly', setInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'require-await': 'error',
    },
  },
  {
    // Runs in the browser, not in node.
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { document: 'readonly', location: 'readonly', WebSocket: 'readonly', fetch: 'readonly', console: 'readonly' },
    },
  },
  {
    // Fakes implement async interfaces without needing to await anything.
    files: ['test/**/*.mjs'],
    rules: { 'require-await': 'off' },
  },
  { ignores: ['node_modules/', 'coverage/'] },
];
