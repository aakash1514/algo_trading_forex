import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      // Internal lib: consumed only via tsconfig path aliases and bundled into the
      // apps, never published, so its package.json doesn't need to list the deps
      // it imports. They are declared once in the root package.json.
      '@nx/dependency-checks': 'off',
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
