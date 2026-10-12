// The only write path for live ticks (market-service's tick DB writer). Live ticks go to the `ticks`
// hypertable; the live candles_* views are continuous aggregates over it. A live feed never writes the
// historical_* tables: those hold the imported Dukascopy history that the backtester, the ML service and
// the research agent read, and only tools/market-data/import writes them (tested in
// tools/market-data/import/src/live-isolation.db.spec.ts and market-service's historical-isolation spec).

export interface LiveTickRow {
  pair: string;        // EUR/USD
  instrument: string;  // EUR_USD
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestamp: string | Date;
  source: string;
}

// Anything with a parameterized query (a TypeORM DataSource or a pg Client).
export interface SqlRunner {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

export const INSERT_LIVE_TICK_SQL =
  `INSERT INTO ticks (time, instrument, pair, bid, ask, mid, spread, source)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export async function insertLiveTick(db: SqlRunner, tick: LiveTickRow): Promise<void> {
  await db.query(INSERT_LIVE_TICK_SQL, [
    new Date(tick.timestamp), // Kafka serializes Date as an ISO string
    tick.instrument,
    tick.pair,
    tick.bid,
    tick.ask,
    tick.mid,
    tick.spread,
    tick.source,
  ]);
}
