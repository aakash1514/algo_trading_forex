export const API_BASE = {
  AUTH:   'http://localhost:3000/api',
  MARKET: 'http://localhost:3002/api',
  DOMAIN: 'http://localhost:3003/api',
  ORDER:  'http://localhost:3004/api',
  WS:     'http://localhost:3005/api',
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

export const MAJOR_PAIRS = [
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF',
  'AUD_USD', 'USD_CAD', 'NZD_USD', 'EUR_GBP',
] as const;

export const PAIR_DISPLAY: Record<string, string> = {
  EUR_USD: 'EUR/USD',
  GBP_USD: 'GBP/USD',
  USD_JPY: 'USD/JPY',
  USD_CHF: 'USD/CHF',
  AUD_USD: 'AUD/USD',
  USD_CAD: 'USD/CAD',
  NZD_USD: 'NZD/USD',
  EUR_GBP: 'EUR/GBP',
};

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = typeof TIMEFRAMES[number];