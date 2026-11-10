// Which live market feed runs, and which prices may be traded on.
//
// MARKET_FEED (read by market-service and order-service, both from the root .env):
//   unset or "none"  no feed (the default): market-service starts no stream, so there is no live price
//                    and order-service rejects every order with "No live price for <pair>".
//   "mock"           the random simulated feed, for development only. Its prices are not market data.
// Any other value fails startup rather than silently picking a feed. A real provider adds its own value
// here (with its source and maximum price age) when one is licensed; MOCK prices are never traded then.

export type MarketFeed = 'none' | 'mock';

// Tick sources, as in the forex.ticks contract (libs/kafka TickMessage.source).
export type PriceSource = 'OANDA' | 'MOCK' | 'TWELVE_DATA';

export function parseMarketFeed(raw: string | undefined): MarketFeed {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'none') return 'none';
  if (value === 'mock') return 'mock';
  throw new Error(`MARKET_FEED must be "none" or "mock", got "${raw}"`);
}

// The sources whose prices may be traded under each setting.
export const FEED_SOURCES: Readonly<Record<MarketFeed, readonly PriceSource[]>> = {
  none: [],
  mock: ['MOCK'],
};

// The oldest price that may still be traded, per source. MOCK: 2 s, the lifetime the Redis price key
// has always had (the mock ticks several times a second).
export const MAX_PRICE_AGE_MS: Readonly<Partial<Record<PriceSource, number>>> = {
  MOCK: 2_000,
};

// A clock difference between services larger than this is an error, not a fresh price.
const MAX_FUTURE_SKEW_MS = 1_000;

export interface PriceStamp {
  timestamp: string | Date;
  source: string;
}

// Rounded up to 0.1 s, so a price just past its limit never reads as within it.
const seconds = (ms: number) => `${Math.ceil(ms / 100) / 10} s`;

// Why this price may not be traded now, or null if it may. `pair` in slash format (EUR/USD).
export function priceProblem(pair: string, price: PriceStamp, feed: MarketFeed, nowMs: number): string | null {
  const source = price.source as PriceSource;
  const maxAge = MAX_PRICE_AGE_MS[source];
  if (!FEED_SOURCES[feed].includes(source) || maxAge === undefined) {
    return `Price for ${pair} comes from source ${price.source}, which the configured market feed (${feed}) does not trade on`;
  }
  const at = new Date(price.timestamp).getTime();
  if (Number.isNaN(at)) return `Price for ${pair} has no valid timestamp`;
  const age = nowMs - at;
  if (age < -MAX_FUTURE_SKEW_MS) return `Price for ${pair} is stamped ${seconds(-age)} in the future (source ${source})`;
  if (age > maxAge) {
    return `Price for ${pair} is stale: last quote ${seconds(age)} old (max ${seconds(maxAge)}, source ${source})`;
  }
  return null;
}

// What the terminal's status dot shows about the feed (ws-gateway computes it from the ticks it relays
// and sends it as feed:status; the browser adds "Disconnected" when its socket is down):
//   'none'   MARKET_FEED=none: no feed is configured ("No live feed")
//   'mock'   the simulator, or any MOCK tick ("Mock feed"); never green
//   'live'   a real feed with a non-MOCK tick no older than the maximum age (the only green state)
//   'stale'  a real feed without such a tick ("Feed stale")
export type FeedDisplayState = 'none' | 'mock' | 'live' | 'stale';

export interface LastTick {
  timestamp: string | Date;
  source: string;
}

export const DEFAULT_FEED_LIVE_MAX_AGE_MS = 10_000;

// FEED_LIVE_MAX_AGE_S (ws-gateway): seconds a real tick counts as live; a positive whole number
export function parseFeedLiveMaxAgeMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_FEED_LIVE_MAX_AGE_MS;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`FEED_LIVE_MAX_AGE_S must be a positive whole number, got "${raw}"`);
  return Number(raw.trim()) * 1000;
}

export function feedDisplayState(feed: MarketFeed, last: LastTick | null, nowMs: number, liveMaxAgeMs: number): FeedDisplayState {
  if (feed === 'none') return 'none';
  if (feed === 'mock' || last?.source === 'MOCK') return 'mock';
  if (!last) return 'stale';
  const age = nowMs - new Date(last.timestamp).getTime();
  // A tick stamped in the future (clock skew) or without a valid time is not evidence of a live feed
  return Number.isFinite(age) && age >= -MAX_FUTURE_SKEW_MS && age <= liveMaxAgeMs ? 'live' : 'stale';
}

// Milliseconds since the last tick, or null without one (sent with the state, for display only)
export function lastTickAgeMs(last: LastTick | null, nowMs: number): number | null {
  if (!last) return null;
  const age = nowMs - new Date(last.timestamp).getTime();
  return Number.isFinite(age) ? Math.max(0, age) : null;
}
