// Bars for replay, built so that nothing after the clock is ever read for display:
//
//   step         the M1 minutes of the next bar: every traded minute after the clock
//                in the same bucket as the first one (weekends and gaps are skipped)
//   current bar  the bar holding the clock, rebuilt from its M1 minutes up to the
//                clock; the aggregate's row for that bucket is never read (it would
//                include the rest of the bar)
//   history      completed aggregate bars strictly before the current bucket
//
// Buckets use the aggregates' own expressions (historicalBucketSql), so a rebuilt
// bar lines up with its aggregate row. Prices are integer points.
import type { DataSource } from 'typeorm';
import { Ohlc } from '@forexedge/trading-sim';
import {
  HISTORICAL_BUCKET_MAX_MS, HistoricalTimeframe, historicalBucketSql, readHistoricalBars,
} from '@forexedge/database';
import { Minute } from './replay-history';

export const HISTORY_BARS = 500;

export interface ReplayBar {
  time: Date;        // bucket start
  lastMinute: Date;  // the latest M1 minute in the bar (<= the clock)
  minutes: number;   // M1 minutes in the bar
  bid: Ohlc;
  ask: Ohlc;
}

const MINUTE_COLUMNS = 'h.time, h.bid_open, h.bid_high, h.bid_low, h.bid_close, h.ask_open, h.ask_high, h.ask_low, h.ask_close';

function toMinute(r: Record<string, unknown>): Minute {
  return {
    time: new Date(r['time'] as string),
    bid: { open: r['bid_open'] as number, high: r['bid_high'] as number, low: r['bid_low'] as number, close: r['bid_close'] as number },
    ask: { open: r['ask_open'] as number, high: r['ask_high'] as number, low: r['ask_low'] as number, close: r['ask_close'] as number },
  };
}

// Every time bound below is a query parameter computed here, never a value joined in
// from another row: TimescaleDB excludes chunks only on bounds it knows when the query
// starts (a bound from a CTE made each step scan all ~4.9M minutes of a pair, 1.2 s).

// The minutes of the next bar after the clock, oldest first; [] at the end of the data
export async function nextBarMinutes(
  dataSource: DataSource, pair: string, timeframe: HistoricalTimeframe, clock: Date,
): Promise<Minute[]> {
  const next: { time: Date }[] = await dataSource.query(
    'SELECT time FROM historical_candles WHERE pair = $1 AND time > $2 ORDER BY time ASC LIMIT 1', [pair, clock]);
  if (next.length === 0) return [];
  const first = new Date(next[0].time);
  const bucket = (column: string) => historicalBucketSql(timeframe, column);
  const rows: Record<string, unknown>[] = await dataSource.query(`
    SELECT ${MINUTE_COLUMNS}
      FROM historical_candles h
     WHERE h.pair = $1 AND h.time >= $2 AND h.time < $3
       AND ${bucket('h.time')} = ${bucket('$2::timestamptz')}
     ORDER BY h.time ASC
  `, [pair, first, new Date(first.getTime() + HISTORICAL_BUCKET_MAX_MS[timeframe])]);
  return rows.map(toMinute);
}

// The bar holding the clock, from its M1 minutes up to and including the clock
export async function currentBar(
  dataSource: DataSource, pair: string, timeframe: HistoricalTimeframe, clock: Date,
): Promise<ReplayBar> {
  const bucket = (column: string) => historicalBucketSql(timeframe, column);
  const rows: Record<string, unknown>[] = await dataSource.query(`
    SELECT ${bucket('$2::timestamptz')} AS bucket, max(h.time) AS last_minute, count(*)::int AS minutes,
           (array_agg(h.bid_open ORDER BY h.time ASC))[1] AS bid_open, max(h.bid_high) AS bid_high,
           min(h.bid_low) AS bid_low, (array_agg(h.bid_close ORDER BY h.time DESC))[1] AS bid_close,
           (array_agg(h.ask_open ORDER BY h.time ASC))[1] AS ask_open, max(h.ask_high) AS ask_high,
           min(h.ask_low) AS ask_low, (array_agg(h.ask_close ORDER BY h.time DESC))[1] AS ask_close
      FROM historical_candles h
     WHERE h.pair = $1 AND h.time > $3 AND h.time <= $2
       AND ${bucket('h.time')} = ${bucket('$2::timestamptz')}
    HAVING count(*) > 0
  `, [pair, clock, new Date(clock.getTime() - HISTORICAL_BUCKET_MAX_MS[timeframe])]);
  if (rows.length === 0) throw new Error(`No ${pair} minute at or before ${clock.toISOString()} in its ${timeframe} bar`);
  const r = rows[0];
  return {
    time: new Date(r['bucket'] as string),
    lastMinute: new Date(r['last_minute'] as string),
    minutes: r['minutes'] as number,
    bid: { open: r['bid_open'] as number, high: r['bid_high'] as number, low: r['bid_low'] as number, close: r['bid_close'] as number },
    ask: { open: r['ask_open'] as number, high: r['ask_high'] as number, low: r['ask_low'] as number, close: r['ask_close'] as number },
  };
}

// Up to `limit` completed bars before the current bucket (oldest first). lastMinute
// is not known for an aggregate row; every minute of these bars is before
// `beforeBucket`, so the bucket start stands in for it as an upper bound check.
export async function historyBars(
  dataSource: DataSource, pair: string, timeframe: HistoricalTimeframe, beforeBucket: Date, limit = HISTORY_BARS,
): Promise<Omit<ReplayBar, 'lastMinute'>[]> {
  const bars = await readHistoricalBars(dataSource, {
    pair, timeframe, to: new Date(beforeBucket.getTime() - 1), limit,
  });
  return bars.map((b) => ({
    time: b.bucket,
    minutes: b.minutes,
    bid: { open: b.bidOpen, high: b.bidHigh, low: b.bidLow, close: b.bidClose },
    ask: { open: b.askOpen, high: b.askHigh, low: b.askLow, close: b.askClose },
  }));
}
