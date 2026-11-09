import { Ohlc } from '@forexedge/trading-sim';
import { ReplayBar } from '../history/replay-bars';
import { pointsToDecimal } from './position.view';

// A bar as the socket sends it: bid and ask OHLC as exact decimal strings.
// lastMinute is the latest M1 minute the bar holds (null for a completed history bar,
// whose minutes all precede the current bar).
export interface BarView {
  time: string;
  lastMinute: string | null;
  minutes: number;
  bid: { open: string; high: string; low: string; close: string };
  ask: { open: string; high: string; low: string; close: string };
}

const ohlc = (q: Ohlc, d: number) => ({
  open: pointsToDecimal(q.open, d), high: pointsToDecimal(q.high, d), low: pointsToDecimal(q.low, d), close: pointsToDecimal(q.close, d),
});

export function barView(bar: Omit<ReplayBar, 'lastMinute'> & { lastMinute?: Date }, priceDecimals: number): BarView {
  return {
    time: bar.time.toISOString(),
    lastMinute: bar.lastMinute ? bar.lastMinute.toISOString() : null,
    minutes: bar.minutes,
    bid: ohlc(bar.bid, priceDecimals),
    ask: ohlc(bar.ask, priceDecimals),
  };
}
