import type { Timeframe } from './constants';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

// Start of the bar (epoch seconds, UTC) that contains `epochSeconds`.
// Matches TimescaleDB time_bucket() for the candle aggregates: its default
// origin (2000-01-03 00:00 UTC) is midnight, so for intervals that divide a
// day, flooring against the Unix epoch yields the same bucket boundaries.
export function alignToBarStart(epochSeconds: number, timeframe: Timeframe): number {
  const size = TIMEFRAME_SECONDS[timeframe];
  return Math.floor(epochSeconds / size) * size;
}
