// Read-only access to the imported history for replay (roadmap step 2 tables,
// through the shared reader in @forexedge/database). Prices stay integer points.
// Nothing here writes: the replay login can't write historical_* at all.
import type { DataSource } from 'typeorm';
import { BidAskBar, pipPoints } from '@forexedge/trading-sim';
import { HistoricalDataError, readHistoricalBars, requireHistoricalCoverage } from '@forexedge/database';

// Contract specs and scale of one pair, from instruments and historical_coverage
export interface PairContext {
  pair: string;           // 'EUR/USD'
  priceDecimals: number;  // historical_price_scale
  pipSize: number;        // instruments.pip_size
  pipPoints: number;      // points per pip
  lotSize: number;        // instruments.lot_size
  maxLeverage: number | null;
  firstTime: Date;        // first and last traded M1 minute of the pair's history
  lastTime: Date;
}

// One M1 minute: its time and its bid/ask OHLC in points
export interface Minute extends BidAskBar {
  time: Date;
}

export async function loadPairContext(dataSource: DataSource, pair: string): Promise<PairContext> {
  const coverage = await requireHistoricalCoverage(dataSource, pair);
  const rows: { pip_size: string; lot_size: number; max_leverage: string | null }[] = await dataSource.query(
    'SELECT pip_size, lot_size, max_leverage FROM instruments WHERE pair = $1', [pair]);
  if (rows.length === 0) throw new HistoricalDataError(`No instruments row for ${pair}`, 'no_coverage');
  const pipSize = Number(rows[0].pip_size);
  // The bounds of what can be replayed: the first and last traded minutes
  const firstTime = await firstMinuteAtOrAfter(dataSource, pair, coverage.firstTime);
  const lastTime = await lastMinuteAtOrBefore(dataSource, pair, coverage.lastTime);
  if (!firstTime || !lastTime) throw new HistoricalDataError(`No historical data for ${pair}`, 'no_coverage');
  return {
    pair,
    priceDecimals: coverage.priceDecimals,
    pipSize,
    pipPoints: pipPoints(pipSize, coverage.priceDecimals),
    lotSize: Number(rows[0].lot_size),
    maxLeverage: rows[0].max_leverage === null ? null : Number(rows[0].max_leverage),
    firstTime,
    lastTime,
  };
}

// The first traded minute at or after `time` (weekends and gaps are skipped), or null
export async function firstMinuteAtOrAfter(dataSource: DataSource, pair: string, time: Date): Promise<Date | null> {
  const rows: { time: Date }[] = await dataSource.query(
    'SELECT time FROM historical_candles WHERE pair = $1 AND time >= $2 ORDER BY time ASC LIMIT 1', [pair, time]);
  return rows.length === 0 ? null : new Date(rows[0].time);
}

// The last traded minute at or before `time`, or null
export async function lastMinuteAtOrBefore(dataSource: DataSource, pair: string, time: Date): Promise<Date | null> {
  const rows: { time: Date }[] = await dataSource.query(
    'SELECT time FROM historical_candles WHERE pair = $1 AND time <= $2 ORDER BY time DESC LIMIT 1', [pair, time]);
  return rows.length === 0 ? null : new Date(rows[0].time);
}

// The M1 minute at exactly `time` (a clock minute always exists)
export async function minuteAt(dataSource: DataSource, pair: string, time: Date): Promise<Minute> {
  const [bar] = await readHistoricalBars(dataSource, { pair, timeframe: '1m', from: time, to: time });
  if (!bar || bar.bucket.getTime() !== time.getTime()) {
    throw new Error(`No ${pair} M1 minute at ${time.toISOString()}`);
  }
  return {
    time: bar.bucket,
    bid: { open: bar.bidOpen, high: bar.bidHigh, low: bar.bidLow, close: bar.bidClose },
    ask: { open: bar.askOpen, high: bar.askHigh, low: bar.askLow, close: bar.askClose },
  };
}
