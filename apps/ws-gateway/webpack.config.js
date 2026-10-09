const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/ws-gateway'),
  },
  optimization: {
    minimize: false,  // Required — TypeORM breaks with minification
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      // Transpile only: type safety lives in `nx typecheck` (tsc --build over
      // project references). The in-build checker can't see unbuilt lib .d.ts files.
      typeCheckOptions: false,
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
    }),
  ],
};