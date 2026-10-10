import { MigrationInterface, QueryRunner } from 'typeorm';
import { HistoricalCandles1791626574903 } from './1791626574903-HistoricalCandles';

// Rebuilds the (still empty) historical schema from 2.1 with integer prices.
//
// Why: decimal prices aren't exact in binary, so float8 columns carry noisy low
// bits that TimescaleDB's XOR float compression can't remove. Measured on a real
// pair-year (EUR/USD 2022): float8 compressed 2.9x (25 MB), integer points 7.7x
// (8.2 MB), i.e. ~1.3 GB vs ~0.42 GB for the full 2010-2022 import. Integer
// points are lossless: every price in the source files is exact at its
// decimals and every volume at 6 decimals (checked over all 52 files).
//
//   price  int4 = price  x 10^price_decimals   (1.08123 -> 108123 at 5 decimals)
//   volume int8 = volume x 10^volume_decimals  (millionths)
//
// The scale of each pair is fixed in historical_price_scale, once for all years.
// Every import-log row references it (composite FK), so a pair can't be loaded
// with two scales, and a scale can't change or disappear while any pair-year is
// imported. Readers convert with the stored scale, never instruments.pip_size.
const NY_CLOSE_ORIGIN = `'2000-01-02 22:00:00+00'`; // Sunday 17:00 America/New_York (EST)

// Price aggregates keep int4; volume sums are cast back to int8 (sum(int8) is numeric).
const OHLC_FROM_M1 = `
  first(bid_open, time) AS bid_open, max(bid_high) AS bid_high,
  min(bid_low) AS bid_low,           last(bid_close, time) AS bid_close,
  first(ask_open, time) AS ask_open, max(ask_high) AS ask_high,
  min(ask_low) AS ask_low,           last(ask_close, time) AS ask_close,
  sum(bid_volume)::bigint AS bid_volume, sum(ask_volume)::bigint AS ask_volume,
  count(*)::integer AS minutes`;

const OHLC_ROLLUP = `
  first(bid_open, bucket) AS bid_open, max(bid_high) AS bid_high,
  min(bid_low) AS bid_low,             last(bid_close, bucket) AS bid_close,
  first(ask_open, bucket) AS ask_open, max(ask_high) AS ask_high,
  min(ask_low) AS ask_low,             last(ask_close, bucket) AS ask_close,
  sum(bid_volume)::bigint AS bid_volume, sum(ask_volume)::bigint AS ask_volume,
  sum(minutes)::integer AS minutes`;

async function assertNoHistoricalRows(queryRunner: QueryRunner, action: string): Promise<void> {
  const [{ candles, imports }] = await queryRunner.query(`
    SELECT EXISTS (SELECT 1 FROM historical_candles) AS candles,
           EXISTS (SELECT 1 FROM historical_import_log) AS imports
  `);
  if (candles || imports) {
    throw new Error(`Refusing to ${action}: historical_candles or historical_import_log has rows. ` +
      'The layout change rebuilds the tables; empty them deliberately first.');
  }
}

export class HistoricalCandlesIntegerPoints1791720000000 implements MigrationInterface {
  name = 'HistoricalCandlesIntegerPoints1791720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertNoHistoricalRows(queryRunner, 'switch historical_candles to integer points');
    await new HistoricalCandles1791626574903().down(queryRunner);

    // ── Fixed scale per pair ─────────────────────────────────────────────
    // price_decimals = pip decimals + 1 (the source quotes fractional pips);
    // volumes are millionths for every pair. More pairs get a row here before
    // their first import.
    await queryRunner.query(`
      CREATE TABLE historical_price_scale (
        pair             VARCHAR(7) NOT NULL,
        price_decimals   SMALLINT   NOT NULL CHECK (price_decimals BETWEEN 0 AND 8),
        volume_decimals  SMALLINT   NOT NULL CHECK (volume_decimals BETWEEN 0 AND 9),
        CONSTRAINT historical_price_scale_pkey PRIMARY KEY (pair),
        CONSTRAINT historical_price_scale_pair_scale_key UNIQUE (pair, price_decimals, volume_decimals)
      )
    `);
    await queryRunner.query(`
      INSERT INTO historical_price_scale (pair, price_decimals, volume_decimals) VALUES
        ('EUR/USD', 5, 6), ('GBP/USD', 5, 6), ('USD/JPY', 3, 6), ('XAU/USD', 3, 6)
    `);

    // ── M1 bid/ask candles, integer points ───────────────────────────────
    // Same constraints as before, on the integers (scaling preserves order).
    // int4 holds 2,147,483,647: gold's 2010-2022 high is 2,075,930 points at 3 dp.
    await queryRunner.query(`
      CREATE TABLE historical_candles (
        time        TIMESTAMPTZ NOT NULL,
        pair        VARCHAR(7)  NOT NULL,
        bid_open    INTEGER     NOT NULL,
        bid_high    INTEGER     NOT NULL,
        bid_low     INTEGER     NOT NULL,
        bid_close   INTEGER     NOT NULL,
        ask_open    INTEGER     NOT NULL,
        ask_high    INTEGER     NOT NULL,
        ask_low     INTEGER     NOT NULL,
        ask_close   INTEGER     NOT NULL,
        bid_volume  BIGINT      NOT NULL,
        ask_volume  BIGINT      NOT NULL,
        CONSTRAINT historical_candles_pkey PRIMARY KEY (pair, time),
        CONSTRAINT historical_candles_bid_ohlc CHECK (
          bid_low > 0 AND bid_low <= bid_open AND bid_low <= bid_close
          AND bid_high >= bid_open AND bid_high >= bid_close),
        CONSTRAINT historical_candles_ask_ohlc CHECK (
          ask_low > 0 AND ask_low <= ask_open AND ask_low <= ask_close
          AND ask_high >= ask_open AND ask_high >= ask_close),
        CONSTRAINT historical_candles_bid_le_ask CHECK (
          bid_open <= ask_open AND bid_high <= ask_high
          AND bid_low <= ask_low AND bid_close <= ask_close),
        CONSTRAINT historical_candles_volume CHECK (bid_volume >= 0 AND ask_volume >= 0)
      )
    `);

    // Chunking and columnstore exactly as in 2.1 (see HistoricalCandles1791626574903).
    await queryRunner.query(`
      SELECT create_hypertable('historical_candles', by_range('time', INTERVAL '30 days'))
    `);
    await queryRunner.query(`
      ALTER TABLE historical_candles SET (
        timescaledb.enable_columnstore = true,
        timescaledb.segmentby = 'pair',
        timescaledb.orderby = 'time'
      )
    `);

    // ── Continuous aggregates (same tree and buckets as 2.1) ─────────────
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW historical_candles_5m
      WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket, pair, ${OHLC_FROM_M1}
        FROM historical_candles
        GROUP BY 1, 2
      WITH NO DATA
    `);
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW historical_candles_15m
      WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT time_bucket(INTERVAL '15 minutes', bucket) AS bucket, pair, ${OHLC_ROLLUP}
        FROM historical_candles_5m
        GROUP BY 1, 2
      WITH NO DATA
    `);
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW historical_candles_1h
      WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket, pair, ${OHLC_ROLLUP}
        FROM historical_candles_15m
        GROUP BY 1, 2
      WITH NO DATA
    `);
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW historical_candles_4h
      WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT time_bucket(INTERVAL '4 hours', time, 'America/New_York', origin => ${NY_CLOSE_ORIGIN}) AS bucket,
               pair, ${OHLC_FROM_M1}
        FROM historical_candles
        GROUP BY 1, 2
      WITH NO DATA
    `);
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW historical_candles_1d
      WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT time_bucket(INTERVAL '1 day', bucket, 'America/New_York', origin => ${NY_CLOSE_ORIGIN}) AS bucket,
               pair, ${OHLC_ROLLUP}
        FROM historical_candles_4h
        GROUP BY 1, 2
      WITH NO DATA
    `);
    for (const view of ['historical_candles_5m', 'historical_candles_15m']) {
      await queryRunner.query(`
        ALTER MATERIALIZED VIEW ${view} SET (
          timescaledb.enable_columnstore = true,
          timescaledb.segmentby = 'pair',
          timescaledb.orderby = 'bucket'
        )
      `);
    }

    // ── Import bookkeeping ───────────────────────────────────────────────
    // As in 2.1, plus the scale each pair-year was converted with. The FK makes
    // it equal to the pair's fixed scale.
    await queryRunner.query(`
      CREATE TABLE historical_import_log (
        pair             VARCHAR(7)  NOT NULL,
        year             SMALLINT    NOT NULL CHECK (year BETWEEN 2000 AND 2100),
        source_file      TEXT        NOT NULL,
        source_sha256    CHAR(64)    NOT NULL,
        source_rows      INTEGER     NOT NULL CHECK (source_rows > 0),
        imported_rows    INTEGER     NOT NULL CHECK (imported_rows >= 0),
        first_time       TIMESTAMPTZ NOT NULL,
        last_time        TIMESTAMPTZ NOT NULL,
        price_decimals   SMALLINT    NOT NULL,
        volume_decimals  SMALLINT    NOT NULL,
        imported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT historical_import_log_pkey PRIMARY KEY (pair, year),
        CONSTRAINT historical_import_log_times CHECK (first_time <= last_time),
        CONSTRAINT historical_import_log_scale_fkey FOREIGN KEY (pair, price_decimals, volume_decimals)
          REFERENCES historical_price_scale (pair, price_decimals, volume_decimals)
      )
    `);
    await queryRunner.query(`
      CREATE VIEW historical_coverage AS
        SELECT l.pair,
               s.price_decimals,
               s.volume_decimals,
               min(l.first_time) AS first_time,
               max(l.last_time)  AS last_time,
               array_agg(l.year ORDER BY l.year) AS years,
               (max(l.year) - min(l.year) + 1) = count(*) AS contiguous,
               sum(l.imported_rows)::bigint AS imported_rows
        FROM historical_import_log l
        JOIN historical_price_scale s ON s.pair = l.pair
        GROUP BY l.pair, s.price_decimals, s.volume_decimals
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertNoHistoricalRows(queryRunner, 'restore the float8 historical layout');
    await queryRunner.query(`DROP VIEW IF EXISTS historical_coverage`);
    await queryRunner.query(`DROP TABLE IF EXISTS historical_import_log`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_1d`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_4h`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_1h`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_15m`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_5m`);
    await queryRunner.query(`DROP TABLE IF EXISTS historical_candles`);
    await queryRunner.query(`DROP TABLE IF EXISTS historical_price_scale`);
    await new HistoricalCandles1791626574903().up(queryRunner);
  }
}
