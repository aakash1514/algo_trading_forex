import { MigrationInterface, QueryRunner } from 'typeorm';

// Real Dukascopy M1 history (roadmap step 2), kept apart from the live
// ticks/candles_* pipeline so charts and backtests never mix the two sources.
//
//   historical_candles (M1, UTC)
//    ├─ historical_candles_5m -> _15m -> _1h      UTC buckets, hierarchical
//    └─ historical_candles_4h (from M1) -> _1d    New York 17:00 close
//
// H4/D1 read M1 directly: TimescaleDB requires a child aggregate to use its
// parent's bucket origin, so an NY-aligned H4 cannot sit on the UTC H1.
//
// Raw SQL, like the ticks hypertable: TypeORM sync doesn't understand
// hypertables or continuous aggregates.
const NY_CLOSE_ORIGIN = `'2000-01-02 22:00:00+00'`; // Sunday 17:00 America/New_York (EST)

const OHLC_FROM_M1 = `
  first(bid_open, time) AS bid_open, max(bid_high) AS bid_high,
  min(bid_low) AS bid_low,           last(bid_close, time) AS bid_close,
  first(ask_open, time) AS ask_open, max(ask_high) AS ask_high,
  min(ask_low) AS ask_low,           last(ask_close, time) AS ask_close,
  sum(bid_volume) AS bid_volume,     sum(ask_volume) AS ask_volume,
  count(*)::integer AS minutes`;

const OHLC_ROLLUP = `
  first(bid_open, bucket) AS bid_open, max(bid_high) AS bid_high,
  min(bid_low) AS bid_low,             last(bid_close, bucket) AS bid_close,
  first(ask_open, bucket) AS ask_open, max(ask_high) AS ask_high,
  min(ask_low) AS ask_low,             last(ask_close, bucket) AS ask_close,
  sum(bid_volume) AS bid_volume,       sum(ask_volume) AS ask_volume,
  sum(minutes)::integer AS minutes`;

export class HistoricalCandles1791626574903 implements MigrationInterface {
  name = 'HistoricalCandles1791626574903';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── M1 bid/ask candles ───────────────────────────────────────────────
    // float8 prices: the source delivers doubles, the app's money math uses
    // JS numbers, and TimescaleDB compresses floats far better than numeric.
    // The CHECKs back up the importer's validation. bid <= ask holds for every
    // field, highs and lows included: at the moment of the lowest ask the bid
    // is at or below it, so ask_low >= bid_low (and likewise for highs).
    await queryRunner.query(`
      CREATE TABLE historical_candles (
        time        TIMESTAMPTZ      NOT NULL,
        pair        VARCHAR(7)       NOT NULL,
        bid_open    DOUBLE PRECISION NOT NULL,
        bid_high    DOUBLE PRECISION NOT NULL,
        bid_low     DOUBLE PRECISION NOT NULL,
        bid_close   DOUBLE PRECISION NOT NULL,
        ask_open    DOUBLE PRECISION NOT NULL,
        ask_high    DOUBLE PRECISION NOT NULL,
        ask_low     DOUBLE PRECISION NOT NULL,
        ask_close   DOUBLE PRECISION NOT NULL,
        bid_volume  DOUBLE PRECISION NOT NULL,
        ask_volume  DOUBLE PRECISION NOT NULL,
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

    // 30-day chunks: ~120k rows (~18 MB) for 4 pairs, ~160 chunks for 2010-2022.
    // Small chunks keep a forced re-import of one year to ~13 chunks to decompress.
    await queryRunner.query(`
      SELECT create_hypertable('historical_candles', by_range('time', INTERVAL '30 days'))
    `);

    // Columnstore (compression), segmented per pair and ordered by time, the way
    // backtests read. Deliberately no compression policy: every chunk is older
    // than any compress-after window, so a policy job could compress a chunk in
    // the middle of an import. The importer compresses explicitly.
    await queryRunner.query(`
      ALTER TABLE historical_candles SET (
        timescaledb.enable_columnstore = true,
        timescaledb.segmentby = 'pair',
        timescaledb.orderby = 'time'
      )
    `);

    // ── Continuous aggregates ────────────────────────────────────────────
    // Static data: materialized only, created empty, no refresh policies. The
    // importer refreshes them after loading. "minutes" counts the M1 bars in a
    // bucket so partial bars (e.g. Sunday-open stubs) stay visible.
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

    // H4 and D1 follow the New York 17:00 close, so a week has 5 daily bars.
    // The timezone argument makes the buckets DST-aware (17:00 NY = 22:00 UTC in
    // winter, 21:00 UTC in summer); the origin alone is a UTC instant, which is
    // why it is written as 22:00+00 (17:00 EST) and not as a bare 17:00.
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

    // The two aggregates over 1M rows get columnstore settings. They are
    // compressed once, after the importer's final refresh (their chunks span
    // ~300 days, so per-year compression would re-compress the same chunks).
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
    // One row per imported pair-year. A re-run skips a pair-year whose file
    // hash matches; coverage is read from here instead of scanning 19M rows.
    await queryRunner.query(`
      CREATE TABLE historical_import_log (
        pair           VARCHAR(7)  NOT NULL,
        year           SMALLINT    NOT NULL CHECK (year BETWEEN 2000 AND 2100),
        source_file    TEXT        NOT NULL,
        source_sha256  CHAR(64)    NOT NULL,
        source_rows    INTEGER     NOT NULL CHECK (source_rows > 0),
        imported_rows  INTEGER     NOT NULL CHECK (imported_rows >= 0),
        first_time     TIMESTAMPTZ NOT NULL,
        last_time      TIMESTAMPTZ NOT NULL,
        imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT historical_import_log_pkey PRIMARY KEY (pair, year),
        CONSTRAINT historical_import_log_times CHECK (first_time <= last_time)
      )
    `);

    await queryRunner.query(`
      CREATE VIEW historical_coverage AS
        SELECT pair,
               min(first_time) AS first_time,
               max(last_time)  AS last_time,
               array_agg(year ORDER BY year) AS years,
               (max(year) - min(year) + 1) = count(*) AS contiguous
        FROM historical_import_log
        GROUP BY pair
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Children before parents.
    await queryRunner.query(`DROP VIEW IF EXISTS historical_coverage`);
    await queryRunner.query(`DROP TABLE IF EXISTS historical_import_log`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_1d`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_4h`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_1h`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_15m`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS historical_candles_5m`);
    await queryRunner.query(`DROP TABLE IF EXISTS historical_candles`);
  }
}
