export const API_BASE = {
  AUTH:   'http://localhost:3000/api',
  MARKET: 'http://localhost:3002/api',
  DOMAIN: 'http://localhost:3003/api',
  ORDER:  'http://localhost:3004/api',
  WS:     'http://localhost:3005/api',
  ML:     'http://localhost:3006/api',
} as const;

export const WS_URL = 'http://localhost:3005';

// Per-user Socket.IO events from ws-gateway. Mirrors SOCKET_EVENTS in
// libs/kafka/src/lib/interfaces/realtime.interface.ts; keep the two in sync.
export const SOCKET_EVENTS = {
  ORDER_UPDATE: 'order:update',
  POSITION_UPDATE: 'position:update',
  POSITIONS_SNAPSHOT: 'positions:snapshot',
  ACCOUNT_UPDATE: 'account:update',
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