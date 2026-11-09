// The bucket of a historical bar, as SQL over an M1 time column, written exactly as
// the continuous aggregates build theirs (migration HistoricalCandlesIntegerPoints):
//
//   5m   time_bucket(5 minutes, time)                     from historical_candles
//   15m  time_bucket(15 minutes, <5m bucket>)              from historical_candles_5m
//   1h   time_bucket(1 hour, <15m bucket>)                 from historical_candles_15m
//   4h   time_bucket(4 hours, time, New York, origin)      from historical_candles
//   1d   time_bucket(1 day, <4h bucket>, New York, origin) from historical_candles_4h
//
// so a bar rebuilt from M1 with these expressions has the same bucket as its
// aggregate row (tested on real minutes in replay-service). The New York buckets
// start at the 17:00 New York close (21:00 or 22:00 UTC with DST), so a 1d bucket
// lasts 23 to 25 hours; HISTORICAL_BUCKET_MAX_MS bounds every bucket's length.
import type { HistoricalTimeframe } from './historical-candles';

// Sunday 17:00 America/New_York (EST): the origin of the New York-aligned buckets
export const NY_CLOSE_ORIGIN = '2000-01-02 22:00:00+00';

const ny = (interval: string, inner: string) =>
  `time_bucket(INTERVAL '${interval}', ${inner}, 'America/New_York', origin => '${NY_CLOSE_ORIGIN}'::timestamptz)`;
const utc = (interval: string, inner: string) => `time_bucket(INTERVAL '${interval}', ${inner})`;

// SQL for the bucket of the M1 time `column` (a column name or a typed parameter)
export function historicalBucketSql(timeframe: HistoricalTimeframe, column: string): string {
  switch (timeframe) {
    case '1m': return column;
    case '5m': return utc('5 minutes', column);
    case '15m': return utc('15 minutes', utc('5 minutes', column));
    case '1h': return utc('1 hour', utc('15 minutes', utc('5 minutes', column)));
    case '4h': return ny('4 hours', column);
    case '1d': return ny('1 day', ny('4 hours', column));
  }
}

// The longest a bucket can last (a 1d bucket on the autumn DST change is 25 hours)
export const HISTORICAL_BUCKET_MAX_MS: Record<HistoricalTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 5 * 3_600_000,
  '1d': 25 * 3_600_000,
};
