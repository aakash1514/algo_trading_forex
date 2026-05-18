import { MigrationInterface, QueryRunner } from 'typeorm';

export class TicksHypertable1778760074714 implements MigrationInterface {
  name = 'TicksHypertable1778760074714';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ----------------------------------------------------------------
    // 1. Create the ticks table
    // ----------------------------------------------------------------
    // We do NOT use TypeORM @Entity() for this table intentionally.
    // Hypertables need special TimescaleDB setup that TypeORM's schema
    // sync doesn't understand. Raw SQL migrations give us full control.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ticks (
        time        TIMESTAMPTZ     NOT NULL,
        instrument  VARCHAR(10)     NOT NULL,
        pair        VARCHAR(7)      NOT NULL,
        bid         DECIMAL(18, 6)  NOT NULL,
        ask         DECIMAL(18, 6)  NOT NULL,
        mid         DECIMAL(18, 6)  NOT NULL,
        spread      DECIMAL(18, 6)  NOT NULL,
        source      VARCHAR(20)     NOT NULL DEFAULT 'MOCK'
      )
    `);

    // ----------------------------------------------------------------
    // 2. Convert to hypertable — this is the TimescaleDB magic
    // ----------------------------------------------------------------
    // create_hypertable() takes the table and the time column.
    // chunk_time_interval: '7 days' means each chunk covers 7 days.
    // if_not_exists: true means re-running migration won't error.
    await queryRunner.query(`
      SELECT create_hypertable(
        'ticks',
        'time',
        chunk_time_interval => INTERVAL '7 days',
        if_not_exists => TRUE
      )
    `);

    // ----------------------------------------------------------------
    // 3. Indexes for common query patterns
    // ----------------------------------------------------------------
    // TimescaleDB automatically creates an index on the time column.
    // We add instrument+time for pair-specific queries (most common).
    // The DESC on time means newest ticks come back first by default.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ticks_instrument_time
      ON ticks (instrument, time DESC)
    `);

    // ----------------------------------------------------------------
    // 4. Continuous aggregate: 1 minute candles
    // ----------------------------------------------------------------
    // time_bucket('1 minute', time) groups ticks into 1-minute windows.
    // FIRST() and LAST() are TimescaleDB functions — they return the
    // first/last value ordered by time within each bucket.
    // This gives us classic OHLCV (Open High Low Close Volume).
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS candles_1m
      WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 minute', time)   AS bucket,
          instrument,
          pair,
          FIRST(mid, time)                AS open,
          MAX(mid)                        AS high,
          MIN(mid)                        AS low,
          LAST(mid, time)                 AS close,
          COUNT(*)                        AS tick_count,
          AVG(spread)                     AS avg_spread
        FROM ticks
        GROUP BY bucket, instrument, pair
      WITH NO DATA
    `);

    // ----------------------------------------------------------------
    // 5. Continuous aggregate: 5 minute candles
    // ----------------------------------------------------------------
    // Built on top of candles_1m — not raw ticks.
    // This is called a "hierarchical continuous aggregate".
    // 5m candle = aggregate of five 1m candles (much faster refresh).
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS candles_5m
      WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('5 minutes', bucket) AS bucket,
          instrument,
          pair,
          FIRST(open, bucket)              AS open,
          MAX(high)                        AS high,
          MIN(low)                         AS low,
          LAST(close, bucket)              AS close,
          SUM(tick_count)                  AS tick_count,
          AVG(avg_spread)                  AS avg_spread
        FROM candles_1m
        GROUP BY time_bucket('5 minutes', bucket), instrument, pair
      WITH NO DATA
    `);

    // ----------------------------------------------------------------
    // 6. Continuous aggregate: 15 minute candles
    // ----------------------------------------------------------------
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS candles_15m
      WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('15 minutes', bucket) AS bucket,
          instrument,
          pair,
          FIRST(open, bucket)               AS open,
          MAX(high)                         AS high,
          MIN(low)                          AS low,
          LAST(close, bucket)               AS close,
          SUM(tick_count)                   AS tick_count,
          AVG(avg_spread)                   AS avg_spread
        FROM candles_5m
        GROUP BY time_bucket('15 minutes', bucket), instrument, pair
      WITH NO DATA
    `);

    // ----------------------------------------------------------------
    // 7. Continuous aggregate: 1 hour candles
    // ----------------------------------------------------------------
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS candles_1h
      WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 hour', bucket)  AS bucket,
          instrument,
          pair,
          FIRST(open, bucket)            AS open,
          MAX(high)                      AS high,
          MIN(low)                       AS low,
          LAST(close, bucket)            AS close,
          SUM(tick_count)                AS tick_count,
          AVG(avg_spread)                AS avg_spread
        FROM candles_15m
        GROUP BY time_bucket('1 hour', bucket), instrument, pair
      WITH NO DATA
    `);

    // ----------------------------------------------------------------
    // 8. Continuous aggregate: 4 hour candles
    // ----------------------------------------------------------------
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS candles_4h
      WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('4 hours', bucket) AS bucket,
          instrument,
          pair,
          FIRST(open, bucket)            AS open,
          MAX(high)                      AS high,
          MIN(low)                       AS low,
          LAST(close, bucket)            AS close,
          SUM(tick_count)                AS tick_count,
          AVG(avg_spread)                AS avg_spread
        FROM candles_1h
        GROUP BY time_bucket('4 hours', bucket), instrument, pair
      WITH NO DATA
    `);

    // ----------------------------------------------------------------
    // 9. Continuous aggregate: 1 day candles
    // ----------------------------------------------------------------
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS candles_1d
      WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', bucket)   AS bucket,
          instrument,
          pair,
          FIRST(open, bucket)            AS open,
          MAX(high)                      AS high,
          MIN(low)                       AS low,
          LAST(close, bucket)            AS close,
          SUM(tick_count)                AS tick_count,
          AVG(avg_spread)                AS avg_spread
        FROM candles_4h
        GROUP BY time_bucket('1 day', bucket), instrument, pair
      WITH NO DATA
    `);

    // ----------------------------------------------------------------
    // 10. Refresh policies — auto-update continuous aggregates
    // ----------------------------------------------------------------
    // Without these, continuous aggregates are never updated automatically.
    // schedule_interval: how often TimescaleDB checks for new data
    // start_offset: how far back to look for new data
    // end_offset: don't aggregate data newer than this (allows ticks to settle)

    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('candles_1m',
        start_offset => INTERVAL '10 minutes',
        end_offset   => INTERVAL '1 minute',
        schedule_interval => INTERVAL '1 minute',
        if_not_exists => TRUE
      )
    `);

    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('candles_5m',
        start_offset => INTERVAL '30 minutes',
        end_offset   => INTERVAL '5 minutes',
        schedule_interval => INTERVAL '5 minutes',
        if_not_exists => TRUE
      )
    `);

    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('candles_15m',
        start_offset => INTERVAL '1 hour',
        end_offset   => INTERVAL '15 minutes',
        schedule_interval => INTERVAL '15 minutes',
        if_not_exists => TRUE
      )
    `);

    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('candles_1h',
        start_offset => INTERVAL '3 hours',
        end_offset   => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour',
        if_not_exists => TRUE
      )
    `);

    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('candles_4h',
        start_offset => INTERVAL '12 hours',
        end_offset   => INTERVAL '4 hours',
        schedule_interval => INTERVAL '4 hours',
        if_not_exists => TRUE
      )
    `);

    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('candles_1d',
        start_offset => INTERVAL '3 days',
        end_offset   => INTERVAL '1 day',
        schedule_interval => INTERVAL '1 day',
        if_not_exists => TRUE
      )
    `);

    // ----------------------------------------------------------------
    // 11. Data retention policy (optional but professional)
    // ----------------------------------------------------------------
    // Raw ticks are huge. Keep 90 days of raw ticks.
    // Candles are small — keep them forever (no policy = keep forever).
    // This automatically drops chunks older than 90 days.
    await queryRunner.query(`
      SELECT add_retention_policy('ticks',
        INTERVAL '90 days',
        if_not_exists => TRUE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order — aggregates first, then table
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS candles_1d CASCADE`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS candles_4h CASCADE`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS candles_1h CASCADE`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS candles_15m CASCADE`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS candles_5m CASCADE`);
    await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS candles_1m CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS ticks CASCADE`);
  }
}