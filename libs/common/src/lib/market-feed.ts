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
