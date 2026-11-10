// Every backend is reached on the page's own origin. In production Caddy routes each /api/<service>
// prefix and the two socket paths to its service; in development `next dev` does the same with the
// rewrites in next.config.js. So no host, port or domain is in the code or the build. The per-service
// keys stay so a call site still says which service it calls.
export const API_BASE = {
  AUTH:   '/api',
  MARKET: '/api',
  DOMAIN: '/api',
  ORDER:  '/api',
  WS:     '/api',
  ML:     '/api',
  RESEARCH: '/api',
  REPLAY: '/api',
} as const;

// ws-gateway's Socket.IO on the default path /socket.io, same origin
export const WS_URL = '/';

// replay-service's Socket.IO: namespace /replay on its own path, under the service's /api/replay
// prefix, so one origin routes it to replay-service and /socket.io to ws-gateway
export const REPLAY_WS_URL = '/replay';
export const REPLAY_SOCKET_PATH = '/api/replay/socket.io';

// Per-user Socket.IO events from ws-gateway. Mirrors SOCKET_EVENTS in
// libs/kafka/src/lib/interfaces/realtime.interface.ts; keep the two in sync.
export const SOCKET_EVENTS = {
  ORDER_UPDATE: 'order:update',
  POSITION_UPDATE: 'position:update',
  POSITIONS_SNAPSHOT: 'positions:snapshot',
  ACCOUNT_UPDATE: 'account:update',
  FEED_STATUS: 'feed:status',
} as const;

// The tradable instruments shown in the terminal and the backtester: the ones
// with imported Dukascopy history (roadmap step 2). Other instrument rows stay
// in the DB; add a pair here only once its history is imported. A cross pair
// (e.g. EUR_GBP) also needs its USD conversion pair's history.
export const MAJOR_PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'XAU_USD'] as const;

export const PAIR_DISPLAY: Record<string, string> = {
  EUR_USD: 'EUR/USD',
  GBP_USD: 'GBP/USD',
  USD_JPY: 'USD/JPY',
  XAU_USD: 'XAU/USD',
};

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = typeof TIMEFRAMES[number];