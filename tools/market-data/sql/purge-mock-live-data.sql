-- Purges ALL live tick data and the live candle continuous aggregates
-- (ticks -> candles_1m -> candles_5m -> candles_15m -> candles_1h -> candles_4h -> candles_1d).
--
-- Used in roadmap step 2 to remove the mock feed's data before real history is
-- imported, and again in step 6 before the Twelve Data feed replaces the mock feed.
-- Only data is removed: the views, their refresh policies and the ticks retention
-- policy stay, so live candles materialize again as soon as new ticks arrive.
-- historical_candles (real Dukascopy history) is a separate table and is untouched.
--
-- Why drop_chunks and not a refresh: TimescaleDB deliberately keeps aggregate rows
-- when raw tick chunks are dropped (retention), so refreshing a window with no ticks
-- leaves the old rows in place. drop_chunks on a continuous aggregate removes its
-- materialized chunks. The cutoff is a year ahead because aggregate chunks are wide
-- (70 days) and the newest one ends after today.
--
-- The aggregates are hierarchical, so they are dropped top-down, then the raw ticks.
--
-- Back up first; pg_dump does not dump a continuous aggregate's materialized rows:
--   \copy (SELECT * FROM candles_1m ORDER BY 1) TO 'candles_1m.csv' WITH (FORMAT csv, HEADER)
--
-- Run from the repo root (Git Bash):
--   docker exec -i forexedge_tsdb psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
--     < tools/market-data/sql/purge-mock-live-data.sql

\echo 'Before:'
SELECT 'ticks' AS relation, count(*) FROM ticks
UNION ALL SELECT 'candles_1m', count(*) FROM candles_1m
UNION ALL SELECT 'candles_5m', count(*) FROM candles_5m
UNION ALL SELECT 'candles_15m', count(*) FROM candles_15m
UNION ALL SELECT 'candles_1h', count(*) FROM candles_1h
UNION ALL SELECT 'candles_4h', count(*) FROM candles_4h
UNION ALL SELECT 'candles_1d', count(*) FROM candles_1d;

BEGIN;
SELECT count(*) AS dropped_candles_1d  FROM drop_chunks('candles_1d',  older_than => now() + interval '1 year');
SELECT count(*) AS dropped_candles_4h  FROM drop_chunks('candles_4h',  older_than => now() + interval '1 year');
SELECT count(*) AS dropped_candles_1h  FROM drop_chunks('candles_1h',  older_than => now() + interval '1 year');
SELECT count(*) AS dropped_candles_15m FROM drop_chunks('candles_15m', older_than => now() + interval '1 year');
SELECT count(*) AS dropped_candles_5m  FROM drop_chunks('candles_5m',  older_than => now() + interval '1 year');
SELECT count(*) AS dropped_candles_1m  FROM drop_chunks('candles_1m',  older_than => now() + interval '1 year');
SELECT count(*) AS dropped_ticks       FROM drop_chunks('ticks',       older_than => now() + interval '1 year');
COMMIT;

\echo 'After:'
SELECT 'ticks' AS relation, count(*) FROM ticks
UNION ALL SELECT 'candles_1m', count(*) FROM candles_1m
UNION ALL SELECT 'candles_5m', count(*) FROM candles_5m
UNION ALL SELECT 'candles_15m', count(*) FROM candles_15m
UNION ALL SELECT 'candles_1h', count(*) FROM candles_1h
UNION ALL SELECT 'candles_4h', count(*) FROM candles_4h
UNION ALL SELECT 'candles_1d', count(*) FROM candles_1d;

\echo 'Remaining chunks (expected: none):'
SELECT c.hypertable_name, c.chunk_name, c.range_start, c.range_end
FROM timescaledb_information.chunks c
WHERE c.hypertable_name = 'ticks'
   OR c.hypertable_name IN (SELECT materialization_hypertable_name
                            FROM timescaledb_information.continuous_aggregates
                            WHERE view_name LIKE 'candles\_%')
ORDER BY 1, 3;
