import { BidAskBar, LevelExit, Ohlc, Side } from './types';

// Fills and exits on real bid/ask bars, all prices in integer points. Shared by
// the backtester (ws-gateway TradeSimulator) and replay, so both trade the same way.
//
//   Fills    An order is known only after the bar (or minute) it was decided on
//            closes, so it fills at the NEXT bar's open: BUY at the ask open, SELL
//            at the bid open; a long closes at the bid open, a short at the ask open.
//   SL/TP    Checked on every bar from the fill bar on, against the fill bar's range
//            after its open: a long on the bid, a short on the ask. A bar that opens
//            beyond a level fills at that open (gap); a level touched inside the bar
//            fills at the level. If SL and TP are both inside one bar, SL wins (the
//            order within a bar is unknown, so assume the worse one).
//   End      A position still open when the data ends is closed at the last bar's
//            close, on the side it exits on.

// Commission: 0.7 pips per side (round trip = 1.4 pips) — realistic ECN cost.
// The spread is not modelled: every fill uses the bar's own bid or ask.
export const COMMISSION_PIPS_PER_SIDE = 0.7;

// The quotes a position exits on (and is valued on): a long sells at the bid, a short buys back at the ask
export function exitQuotes(side: Side, bar: BidAskBar): Ohlc {
  return side === 'BUY' ? bar.bid : bar.ask;
}

// The quotes a position opens on: BUY at the ask, SELL at the bid
export function entryQuotes(side: Side, bar: BidAskBar): Ohlc {
  return side === 'BUY' ? bar.ask : bar.bid;
}

// Opening fill at a bar's open: BUY at the ask, SELL at the bid
export function entryFill(side: Side, bar: BidAskBar): number {
  return side === 'BUY' ? bar.ask.open : bar.bid.open;
}

// Closing fill at a bar's open
export function exitFill(side: Side, bar: BidAskBar): number {
  return exitQuotes(side, bar).open;
}

// Closing price at a bar's close (end of data, marking to market)
export function closeQuote(side: Side, bar: BidAskBar): number {
  return exitQuotes(side, bar).close;
}

// Stop loss / take profit on one bar's exit-side quotes (see the header); null when neither is hit
export function levelExit(side: Side, stopLoss: number | undefined, takeProfit: number | undefined, quotes: Ohlc): LevelExit | null {
  const sl = stopLoss;
  const tp = takeProfit;
  if (side === 'BUY') {
    if (sl !== undefined && quotes.open <= sl) return { points: quotes.open, reason: 'STOP_LOSS' };
    if (tp !== undefined && quotes.open >= tp) return { points: quotes.open, reason: 'TAKE_PROFIT' };
    if (sl !== undefined && quotes.low <= sl) return { points: sl, reason: 'STOP_LOSS' };
    if (tp !== undefined && quotes.high >= tp) return { points: tp, reason: 'TAKE_PROFIT' };
  } else {
    if (sl !== undefined && quotes.open >= sl) return { points: quotes.open, reason: 'STOP_LOSS' };
    if (tp !== undefined && quotes.open <= tp) return { points: quotes.open, reason: 'TAKE_PROFIT' };
    if (sl !== undefined && quotes.high >= sl) return { points: sl, reason: 'STOP_LOSS' };
    if (tp !== undefined && quotes.low <= tp) return { points: tp, reason: 'TAKE_PROFIT' };
  }
  return null;
}

// Points per pip (pip_size x 10^decimals): 10 at every pair's scale; anything that
// isn't a whole number of points is rejected
export function pipPoints(pipSize: number, priceDecimals: number): number {
  const points = Math.round(pipSize * 10 ** priceDecimals * 1e6) / 1e6;
  if (!Number.isInteger(points) || points < 1) {
    throw new Error(`pip size ${pipSize} is not a whole number of points at ${priceDecimals} decimals`);
  }
  return points;
}

// A price level -> points, rounded once to the nearest point
export function priceToPoints(price: number, priceDecimals: number): number {
  return Math.round(price * 10 ** priceDecimals);
}
