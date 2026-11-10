import { closeQuote, markToMarketCents, pipPoints, type BidAskBar, type Ohlc } from '@forexedge/trading-sim';
import { getPipSize } from './pip';
import { decimalToPoints } from './replay';
import type { Quote, ReplayBar, ReplayPosition } from '../types/replay.types';

// Live P&L of one open replay position. The server sends only the account's total
// (unrealizedPnlUsd), so each row is computed here with the server's own formula,
// @forexedge/trading-sim's markToMarketCents (pure functions, no I/O): what the
// position would net if closed at the clock minute's close (a long at the bid, a short
// at the ask), round-trip commission deducted, USD/JPY converted at that price. The
// current bar's close is the clock minute's close, so the rows add up to the server's
// total exactly (tested on recorded responses).

const points = (q: Quote, decimals: number): Ohlc => {
  const p = (text: string) => {
    const v = decimalToPoints(text, decimals);
    if (v === null) throw new Error(`Not a price at ${decimals} decimals: ${text}`);
    return v;
  };
  return { open: p(q.open), high: p(q.high), low: p(q.low), close: p(q.close) };
};

export function barToPoints(bar: ReplayBar, decimals: number): BidAskBar {
  return { bid: points(bar.bid, decimals), ask: points(bar.ask, decimals) };
}

// Cents, or null for a position that isn't open
export function openPnlCents(position: ReplayPosition, currentBar: ReplayBar, instrument: string, decimals: number): bigint | null {
  if (position.status !== 'OPEN' || position.entryPrice === null) return null;
  const entry = decimalToPoints(position.entryPrice, decimals);
  if (entry === null) throw new Error(`Not a price at ${decimals} decimals: ${position.entryPrice}`);
  const quote = closeQuote(position.side, barToPoints(currentBar, decimals));
  return markToMarketCents(position.side, entry, quote, {
    pair: instrument.replace('_', '/'),
    units: position.units,
    priceDecimals: decimals,
    pipPoints: pipPoints(getPipSize(instrument), decimals),
  });
}
