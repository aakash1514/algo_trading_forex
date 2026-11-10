//@ts-check

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { composePlugins, withNx } = require('@nx/next');

// Development only: `next dev` forwards each service's prefix to its local port, as Caddy does in
// production (infra/caddy/Caddyfile), so the browser calls one origin in both. A production build
// (`next build`, NODE_ENV=production) gets no rewrites, so no localhost address is built in.
// The socket paths are rewritten too (WebSocket upgrades included).
/** @type {{ prefix: string, port: number }[]} */
const DEV_BACKENDS = [
  { prefix: '/api/auth', port: 3000 },
  { prefix: '/api/market', port: 3002 },
  { prefix: '/api/domain', port: 3003 },
  { prefix: '/api/orders', port: 3004 },
  { prefix: '/api/positions', port: 3004 },
  { prefix: '/api/account', port: 3004 },
  { prefix: '/api/backtest', port: 3005 },
  { prefix: '/socket.io', port: 3005 },
  { prefix: '/api/ml', port: 3006 },
  { prefix: '/api/research', port: 3007 },
  { prefix: '/api/replay', port: 3008 },
];

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  // Use this to set Nx-specific options
  // See: https://nx.dev/recipes/next/next-config-setup
  nx: {},
  // A self-contained server (server.js + only the node_modules it needs) for the Docker image
  output: 'standalone',
  // Socket.IO requests /socket.io/?EIO=4…; the default trailing-slash redirect would break it
  skipTrailingSlashRedirect: true,
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    // The socket paths first, with their trailing slash: Engine.IO serves only <path>/, and the generic
    // rules below would forward /socket.io/?EIO=4… as /socket.io?EIO=4… (the upgrade then hangs up).
    const sockets = [
      { path: '/socket.io/', port: 3005 },
      { path: '/api/replay/socket.io/', port: 3008 },
    ].map(({ path, port }) => ({ source: path, destination: `http://127.0.0.1:${port}${path}` }));
    return [...sockets, ...DEV_BACKENDS.flatMap(({ prefix, port }) => [
      { source: prefix, destination: `http://127.0.0.1:${port}${prefix}` },
      { source: `${prefix}/:path*`, destination: `http://127.0.0.1:${port}${prefix}/:path*` },
    ])];
  },
};

const plugins = [
  // Add more Next.js plugins to this list if needed.
  withNx,
];

module.exports = composePlugins(...plugins)(nextConfig);
