import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

export default [
  { plugins: { '@next/next': nextEslintPluginNext } },
  ...nx.configs['flat/react-typescript'],
  ...baseConfig,
  {
    // `**/` prefix: the Nx lint executor runs ESLint from the workspace root with
    // this file as overrideConfigFile, so ignore patterns resolve against the root.
    // next-env.d.ts is generated; after `next build` it imports from dist/.
    ignores: ['**/.next/**', '**/next-env.d.ts'],
  },
];
