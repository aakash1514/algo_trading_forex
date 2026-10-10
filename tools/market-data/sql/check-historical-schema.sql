-- Verifies the historical_candles schema (migrations HistoricalCandles1791626574903 and
-- HistoricalCandlesIntegerPoints1791720000000).
-- Every check raises an exception on failure, so a clean run ends with "ALL OK".
--
--   docker exec -i forexedge_tsdb psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
--     < tools/market-data/sql/check-historical-schema.sql

\set QUIET on

-- 1. Hypertable: 30-day time chunks.
DO $$
DECLARE interval_found interval;
BEGIN
  SELECT time_interval INTO interval_found FROM timescaledb_information.dimensions
  WHERE hypertable_name = 'historical_candles' AND column_name = 'time';
  IF interval_found IS DISTINCT FROM INTERVAL '30 days' THEN
    RAISE EXCEPTION 'historical_candles chunk interval is %, expected 30 days', interval_found;
  END IF;
END $$;

-- 2. Columnstore: segmentby pair, orderby time; no compression or refresh jobs.
DO $$
DECLARE seg text; ord text; jobs int;
BEGIN
  SELECT string_agg(attname, ',') FILTER (WHERE segmentby_column_index IS NOT NULL),
         string_agg(attname, ',') FILTER (WHERE orderby_column_index IS NOT NULL)
    INTO seg, ord
  FROM timescaledb_information.compression_settings WHERE hypertable_name = 'historical_candles';
  IF seg IS DISTINCT FROM 'pair' OR ord IS DISTINCT FROM 'time' THEN
    RAISE EXCEPTION 'historical_candles columnstore segmentby=% orderby=%, expected pair/time', seg, ord;
  END IF;

  SELECT count(*) INTO jobs FROM timescaledb_information.jobs
  WHERE hypertable_name LIKE 'historical\_candles%'
     OR hypertable_name IN (SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates
                            WHERE view_name LIKE 'historical\_candles%');
  IF jobs <> 0 THEN
    RAISE EXCEPTION '% background job(s) attached to historical objects, expected none', jobs;
  END IF;
END $$;

-- 3. Primary key and CHECK constraints.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
  FROM unnest(ARRAY['historical_candles_pkey', 'historical_candles_bid_ohlc', 'historical_candles_ask_ohlc',
                    'historical_candles_bid_le_ask', 'historical_candles_volume']) AS name
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'historical_candles'::regclass AND conname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing constraints: %', missing;
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'historical_candles_pkey'))
     <> 'PRIMARY KEY (pair, "time")' THEN
    RAISE EXCEPTION 'unexpected primary key definition';
  END IF;
END $$;

-- 4. Aggregates: parents, materialized-only, NY timezone on H4/D1, columnstore on 5m/15m.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('historical_candles_5m',  'historical_candles',     false, true),
      ('historical_candles_15m', 'historical_candles_5m',  false, true),
      ('historical_candles_1h',  'historical_candles_15m', false, false),
      ('historical_candles_4h',  'historical_candles',     true,  false),
      ('historical_candles_1d',  'historical_candles_4h',  true,  false)
    ) AS expected(view_name, parent, new_york, columnstore)
  LOOP
    PERFORM 1
    FROM _timescaledb_catalog.continuous_agg c
    JOIN timescaledb_information.continuous_aggregates i ON i.view_name = c.user_view_name
    LEFT JOIN _timescaledb_catalog.continuous_agg p ON p.mat_hypertable_id = c.raw_hypertable_id
    JOIN _timescaledb_catalog.hypertable h ON h.id = c.raw_hypertable_id
    WHERE c.user_view_name = r.view_name
      AND coalesce(p.user_view_name, h.table_name) = r.parent
      AND i.materialized_only
      AND i.compression_enabled = r.columnstore
      AND (i.view_definition LIKE '%America/New_York%') = r.new_york;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% does not match: parent %, NY buckets %, columnstore %',
        r.view_name, r.parent, r.new_york, r.columnstore;
    END IF;
  END LOOP;
END $$;

-- 5. New York close buckets (same expression as the H4/D1 views), checked on fixed
--    instants around both 2022 DST changes. NY 17:00 is 22:00 UTC in winter (EST)
--    and 21:00 UTC in summer (EDT); H4 bars start at 17, 21, 01, 05, 09, 13 NY.
DO $$
DECLARE r record; h4 timestamptz; d1 timestamptz;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- minute (UTC)            expected H4 start         expected D1 start
      ('2022-01-10 21:59Z'::timestamptz, '2022-01-10 18:00Z'::timestamptz, '2022-01-09 22:00Z'::timestamptz), -- winter, last minute of the day
      ('2022-01-10 22:00Z',              '2022-01-10 22:00Z',              '2022-01-10 22:00Z'),              -- winter, first minute of the next day
      ('2022-07-11 20:59Z',              '2022-07-11 17:00Z',              '2022-07-10 21:00Z'),              -- summer, last minute of the day
      ('2022-07-11 21:00Z',              '2022-07-11 21:00Z',              '2022-07-11 21:00Z'),              -- summer, first minute of the next day
      ('2022-07-12 01:00Z',              '2022-07-12 01:00Z',              '2022-07-11 21:00Z'),              -- summer, second H4 of the day
      ('2022-03-11 21:59Z',              '2022-03-11 18:00Z',              '2022-03-10 22:00Z'),              -- Friday close before DST starts (EST)
      ('2022-03-13 21:00Z',              '2022-03-13 21:00Z',              '2022-03-13 21:00Z'),              -- Sunday open after DST starts (EDT)
      ('2022-11-04 20:59Z',              '2022-11-04 17:00Z',              '2022-11-03 21:00Z'),              -- Friday close before DST ends (EDT)
      ('2022-11-06 22:00Z',              '2022-11-06 22:00Z',              '2022-11-06 22:00Z')               -- Sunday open after DST ends (EST)
    ) AS t(minute, h4_start, d1_start)
  LOOP
    h4 := time_bucket(INTERVAL '4 hours', r.minute, 'America/New_York', origin => '2000-01-02 22:00:00+00');
    d1 := time_bucket(INTERVAL '1 day',   r.minute, 'America/New_York', origin => '2000-01-02 22:00:00+00');
    IF h4 <> r.h4_start OR d1 <> r.d1_start THEN
      RAISE EXCEPTION 'minute %: H4 % (expected %), D1 % (expected %)', r.minute, h4, r.h4_start, d1, r.d1_start;
    END IF;
  END LOOP;
END $$;

-- 3b. Integer points: int4 prices, int8 volumes, in M1 and in every aggregate.
DO $$
DECLARE wrong text;
BEGIN
  SELECT string_agg(format('%s.%s is %s', c.table_name, c.column_name, c.data_type), '; ') INTO wrong
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND (c.table_name = 'historical_candles' OR c.table_name LIKE 'historical\_candles\_%')
    AND c.column_name NOT IN ('time', 'bucket', 'pair', 'minutes')
    AND c.data_type <> CASE WHEN c.column_name LIKE '%volume' THEN 'bigint' ELSE 'integer' END;
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'non-integer historical columns: %', wrong;
  END IF;
END $$;

-- 3c. One fixed scale per pair: historical_price_scale rows for the 4 pairs, and
--     every import-log row tied to its pair's scale by a composite FK.
DO $$
DECLARE scales text;
BEGIN
  SELECT string_agg(format('%s:%s/%s', pair, price_decimals, volume_decimals), ',' ORDER BY pair) INTO scales
  FROM historical_price_scale;
  IF scales IS DISTINCT FROM 'EUR/USD:5/6,GBP/USD:5/6,USD/JPY:3/6,XAU/USD:3/6' THEN
    RAISE EXCEPTION 'historical_price_scale is %, expected EUR/USD:5/6,GBP/USD:5/6,USD/JPY:3/6,XAU/USD:3/6', scales;
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'historical_import_log_scale_fkey'))
     IS DISTINCT FROM 'FOREIGN KEY (pair, price_decimals, volume_decimals) REFERENCES historical_price_scale(pair, price_decimals, volume_decimals)' THEN
    RAISE EXCEPTION 'historical_import_log_scale_fkey is missing or different';
  END IF;
END $$;

-- 6. Import log and coverage view exist.
DO $$
BEGIN
  IF to_regclass('historical_import_log') IS NULL OR to_regclass('historical_coverage') IS NULL THEN
    RAISE EXCEPTION 'historical_import_log or historical_coverage is missing';
  END IF;
END $$;

-- 7. The live pipeline is untouched: 6 candles_* views and their 6 refresh policies.
DO $$
DECLARE views int; policies int;
BEGIN
  SELECT count(*) INTO views FROM timescaledb_information.continuous_aggregates WHERE view_name LIKE 'candles\_%';
  SELECT count(*) INTO policies FROM timescaledb_information.jobs
  WHERE proc_name = 'policy_refresh_continuous_aggregate' AND hypertable_name LIKE 'candles\_%';
  IF views <> 6 OR policies <> 6 THEN
    RAISE EXCEPTION 'live pipeline changed: % candles_* views, % refresh policies (expected 6 and 6)', views, policies;
  END IF;
END $$;

\echo 'ALL OK'
