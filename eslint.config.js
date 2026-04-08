'use strict';

const globals = require('globals');

module.exports = [
  {
    files: ['*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Warn on unused variables (ignore _-prefixed intentional ignores and catch bindings)
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
    },
  },
];
