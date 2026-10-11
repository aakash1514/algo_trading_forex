import { HistoricalTimeframe } from '@forexedge/database';

// The bars a backtest covers, from its From and To days (both inclusive, UTC).
//
//   from        From day 00:00 UTC (inclusive)
//   end         the day after To, 00:00 UTC (exclusive)
//   lastBucket  start of the last bar that lies entirely before `end`
//
// Only whole bars are used: a bar is in the window when bucket >= from and
// bucket + timeframe <= end. With To = Wednesday, the H1 bar at Wednesday 23:00
// is in; the New York-aligned D1 bar that starts Wednesday 17:00 NY (21:00/22:00
// UTC) is out, because nearly all of it is Thursday. A fixed bar length is exact
// for the NY-aligned 4h/1d bars too: DST switches happen on Sunday 02:00 NY, while
// the market is closed, so no bar with data spans one.
export interface BacktestWindow {
  from: Date;
  end: Date;
  lastBucket: Date;
  days: number;
}

export const DAY_MS = 86_400_000;

export const TIMEFRAME_MS: Record<HistoricalTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': DAY_MS,
};

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' -> that day's 00:00 UTC; anything else (a timestamp, 2022-02-30)
// is rejected rather than normalised
export function parseDay(day: string): Date {
  const match = DAY_PATTERN.exec(day);
  if (match) {
    const [, y, m, d] = match.map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return date;
  }
  throw new RangeError(`${day} is not a calendar date (YYYY-MM-DD)`);
}

export function backtestWindow(fromDay: string, toDay: string, timeframe: HistoricalTimeframe): BacktestWindow {
  const from = parseDay(fromDay);
  const to = parseDay(toDay);
  if (from > to) throw new RangeError(`fromDate ${fromDay} is after toDate ${toDay}`);
  const barMs = TIMEFRAME_MS[timeframe];
  if (!barMs) throw new RangeError(`Unknown timeframe ${timeframe}`);
  const end = new Date(to.getTime() + DAY_MS);
  return { from, end, lastBucket: new Date(end.getTime() - barMs), days: (end.getTime() - from.getTime()) / DAY_MS };
}
