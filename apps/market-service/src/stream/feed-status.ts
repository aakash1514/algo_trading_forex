import type { MarketFeed, PriceSource } from '@forexedge/common';

// The live feed's state, served at GET /api/market/feed/status for the trading terminal.
//   off        no feed configured (MARKET_FEED=none, the default): no stream, no prices
//   connected  the provider is streaming; its ticks are published
//   degraded   the provider failed; reconnecting with backoff, nothing is published meanwhile
//   down       reconnecting has failed DOWN_AFTER_FAILURES times in a row; still retrying at the
//              longest backoff, nothing is published
// Prices are never replaced while degraded or down: they age out and order-service rejects them as stale.
export type FeedState = 'off' | 'connected' | 'degraded' | 'down';

export interface FeedStatus {
  feed: MarketFeed;
  source: PriceSource | null;
  simulated: boolean;          // true only for MARKET_FEED=mock: the prices are not market data
  state: FeedState;
  since: string;               // when the state last changed (ISO)
  lastTickAt: string | null;   // last tick published (ISO)
  lastError: string | null;    // error type only (never a provider message, which could carry a key)
}

export const FEED_SOURCE: Readonly<Record<MarketFeed, PriceSource | null>> = { none: null, mock: 'MOCK' };

export const DOWN_AFTER_FAILURES = 3;
const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 60_000;

// Delay before reconnect attempt n (1-based): 1 s, 2 s, 4 s, ... capped at 60 s.
export function retryDelayMs(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
}
