import type { FeedStatus } from '../types/api.types';

// The oldest price that may still be traded, per tick source. Mirrors MAX_PRICE_AGE_MS in
// libs/common/src/lib/market-feed.ts (order-service enforces it; this only drives the display).
export const MAX_PRICE_AGE_MS: Readonly<Record<string, number>> = { MOCK: 2_000 };

export const NO_FEED_MESSAGE = 'No live market feed';
// Shown with the no-feed banner: the historical replay works without a feed
export const REPLAY_LINK = { href: '/replay', label: 'Try historical Replay →' } as const;
export const SIMULATED_MESSAGE = 'SIMULATED PRICES — not market data';

export interface TerminalPrice {
  bid: number;
  ask: number;
  timestamp: string;
  source: string;
}

export type PriceState = 'none' | 'fresh' | 'stale';

// Fresh while younger than its source's maximum age; a source with no maximum is never tradable.
export function priceState(price: TerminalPrice | undefined, nowMs: number): PriceState {
  if (!price) return 'none';
  const maxAge = MAX_PRICE_AGE_MS[price.source];
  const age = nowMs - new Date(price.timestamp).getTime();
  return maxAge !== undefined && age <= maxAge ? 'fresh' : 'stale';
}

export interface FeedBanner {
  tone: 'neutral' | 'simulated' | 'warning';
  text: string;
  link?: { href: string; label: string };
}

export function feedBanner(status: FeedStatus | undefined, statusError: boolean): FeedBanner | null {
  if (statusError) return { tone: 'warning', text: 'Market feed status unavailable — is market-service running? Orders are disabled.' };
  if (!status) return null;
  if (status.feed === 'none' || status.state === 'off') return { tone: 'neutral', text: NO_FEED_MESSAGE, link: REPLAY_LINK };
  if (status.state === 'degraded' || status.state === 'down') {
    return { tone: 'warning', text: `Market feed ${status.state}: prices are stale and orders are rejected until it reconnects.` };
  }
  if (status.simulated) return { tone: 'simulated', text: `${SIMULATED_MESSAGE}. Paper trades here use simulated prices.` };
  return null;
}

export interface OrderEntry {
  enabled: boolean;
  label: string;          // the submit button's action text prefix
  reason: string | null;  // why order entry is disabled
}

// Mirrors order-service's gates for the display only; the server decides.
export function orderEntry(
  status: FeedStatus | undefined, statusError: boolean, pair: string, price: TerminalPrice | undefined, nowMs: number,
): OrderEntry {
  const disabled = (reason: string): OrderEntry => ({ enabled: false, label: 'Paper trade', reason });
  if (statusError || !status) return disabled('Market feed status unavailable');
  if (status.feed === 'none' || status.state === 'off') return disabled(`No live price for ${pair}`);
  if (status.state !== 'connected') return disabled(`Market feed ${status.state}: no fresh prices`);
  const state = priceState(price, nowMs);
  if (state === 'none') return disabled(`No live price for ${pair}`);
  if (state === 'stale') return disabled(`Price for ${pair} is stale`);
  return { enabled: true, label: status.simulated ? 'Paper trade on simulated prices' : 'Paper trade', reason: null };
}
