// Reads the imported Dukascopy history (roadmap step 2), shared by the candles
// API (?source=historical) and the backtester so both route, convert and check
// coverage the same way.
//
//   1m      historical_candles      (M1, column "time")
//   5m-1h   historical_candles_5m/_15m/_1h   (UTC buckets)
//   4h, 1d  historical_candles_4h/_1d        (New York 17:00 close)
//
// Prices are stored as integer points (price x 10^price_decimals) with the scale
// fixed per pair in historical_price_scale; bars are returned in points and the
// caller converts with that scale (never with instruments.pip_size).
import type { DataSource } from 'typeorm';

export const HISTORICAL_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type HistoricalTimeframe = (typeof HISTORICAL_TIMEFRAMES)[number];

export const HISTORICAL_SOURCES: Record<HistoricalTimeframe, { table: string; time: string; minutes: string }> = {
  '1m':  { table: 'historical_candles',     time: 'time',   minutes: '1' },
  '5m':  { table: 'historical_candles_5m',  time: 'bucket', minutes: 'minutes' },
  '15m': { table: 'historical_candles_15m', time: 'bucket', minutes: 'minutes' },
  '1h':  { table: 'historical_candles_1h',  time: 'bucket', minutes: 'minutes' },
  '4h':  { table: 'historical_candles_4h',  time: 'bucket', minutes: 'minutes' },
  '1d':  { table: 'historical_candles_1d',  time: 'bucket', minutes: 'minutes' },
};

export interface HistoricalCoverage {
  pair: string;
  priceDecimals: number;
  firstTime: Date;
  lastTime: Date;
}

// One bar in integer points (bid/ask OHLC) with the M1 bars it holds
export interface HistoricalBar {
  bucket: Date;
  bidOpen: number;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askOpen: number;
  askHigh: number;
  askLow: number;
  askClose: number;
  minutes: number;
}

export type HistoricalDataErrorKind = 'no_coverage' | 'out_of_range';

export class HistoricalDataError extends Error {
  constructor(message: string, readonly kind: HistoricalDataErrorKind) {
    super(message);
  }
}

export async function getHistoricalCoverage(dataSource: DataSource, pair: string): Promise<HistoricalCoverage | null> {
  const rows = await dataSource.query(
    `SELECT pair, price_decimals, first_time, last_time FROM historical_coverage WHERE pair = $1`, [pair]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { pair: r.pair, priceDecimals: r.price_decimals, firstTime: new Date(r.first_time), lastTime: new Date(r.last_time) };
}

// The coverage of a pair, or an error when it has none or the requested window
// (either bound optional) doesn't overlap it.
export async function requireHistoricalCoverage(
  dataSource: DataSource, pair: string, from?: Date, to?: Date,
): Promise<HistoricalCoverage> {
  const coverage = await getHistoricalCoverage(dataSource, pair);
  if (!coverage) throw new HistoricalDataError(`No historical data for ${pair}`, 'no_coverage');
  if ((from && from > coverage.lastTime) || (to && to < coverage.firstTime) || (from && to && from > to)) {
    throw new HistoricalDataError(
      `Requested range is outside the historical data for ${pair}: ` +
        `${coverage.firstTime.toISOString()} to ${coverage.lastTime.toISOString()}`, 'out_of_range');
  }
  return coverage;
}

export interface HistoricalBarQuery {
  pair: string;
  timeframe: HistoricalTimeframe;
  from?: Date; // inclusive
  to?: Date;   // inclusive
  // With a limit, the latest bars of the window (returned oldest first)
  limit?: number;
}

export async function readHistoricalBars(dataSource: DataSource, q: HistoricalBarQuery): Promise<HistoricalBar[]> {
  const source = HISTORICAL_SOURCES[q.timeframe];
  if (!source) throw new Error(`Unknown historical timeframe ${q.timeframe}`);
  const conditions = ['pair = $1'];
  const params: unknown[] = [q.pair];
  if (q.from) { params.push(q.from); conditions.push(`${source.time} >= $${params.length}`); }
  if (q.to) { params.push(q.to); conditions.push(`${source.time} <= $${params.length}`); }
  let tail = `ORDER BY ${source.time} ASC`;
  if (q.limit !== undefined) { params.push(q.limit); tail = `ORDER BY ${source.time} DESC LIMIT $${params.length}`; }

  const rows: Record<string, unknown>[] = await dataSource.query(`
    SELECT ${source.time} AS bucket, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close,
           ${source.minutes}::int AS minutes
    FROM ${source.table}
    WHERE ${conditions.join(' AND ')}
    ${tail}
  `, params);
  const bars = rows.map((r) => ({
    bucket: new Date(r['bucket'] as string),
    bidOpen: r['bid_open'] as number, bidHigh: r['bid_high'] as number,
    bidLow: r['bid_low'] as number, bidClose: r['bid_close'] as number,
    askOpen: r['ask_open'] as number, askHigh: r['ask_high'] as number,
    askLow: r['ask_low'] as number, askClose: r['ask_close'] as number,
    minutes: r['minutes'] as number,
  }));
  return q.limit !== undefined ? bars.reverse() : bars;
}

// Points -> price at the pair's scale (for display and indicators; money math in
// points stays exact)
export function pointsToPrice(points: number, priceDecimals: number): number {
  return points / 10 ** priceDecimals;
}
