-- Independent check of the walk-forward samples and naive baselines, from the H1 bars
-- in SQL (integer points, no Python code). For each pair and test year 2016-2022 it
-- counts the test samples, the up targets, and the hits of the majority, persistence
-- and anti-persistence baselines; the Python report must match every count exactly.
--
-- Rules, restated from the step-4 plan:
--   sample     decision bar i (0-based from 2010-01-01) with i >= :window, whose next
--              bar exists, holds >= 30 minutes and is not flat (2 x mid open <> close)
--   target     1 if the next bar's bid_close + ask_close > bid_open + ask_open, else 0
--   period     the target bar's year; training = targets 2010-01-01 .. Y-1 Jan 1
--   majority   up if the training up-count is at least half of the training samples
--   persistence / anti-persistence   bar i's own direction (or its opposite); a flat
--              bar i falls back to the majority direction
-- Parameters: %(pairs)s text[], %(window)s int.
WITH b AS (
  SELECT pair,
         row_number() OVER w - 1                      AS i,
         sign((bid_close + ask_close) - (bid_open + ask_open)) AS dir,
         lead(bucket)  OVER w                          AS next_bucket,
         lead(minutes) OVER w                          AS next_minutes,
         lead(bid_open + ask_open)   OVER w            AS next_o2,
         lead(bid_close + ask_close) OVER w            AS next_c2
  FROM historical_candles_1h
  WHERE pair = ANY(%(pairs)s) AND bucket >= '2010-01-01T00:00Z' AND bucket < '2023-01-01T00:00Z'
  WINDOW w AS (PARTITION BY pair ORDER BY bucket)
),
s AS (
  SELECT pair, dir, extract(year FROM next_bucket AT TIME ZONE 'UTC')::int AS target_year,
         (next_c2 > next_o2)::int AS y
  FROM b
  WHERE i >= %(window)s AND next_bucket IS NOT NULL AND next_minutes >= 30 AND next_c2 <> next_o2
),
folds AS (SELECT generate_series(2016, 2022) AS test_year),
majority AS (
  SELECT f.test_year, s.pair, (2 * sum(s.y) >= count(*))::int AS maj
  FROM folds f JOIN s ON s.target_year >= 2010 AND s.target_year < f.test_year - 1
  GROUP BY f.test_year, s.pair
)
SELECT s.pair, f.test_year,
       count(*)                                                        AS n,
       sum(s.y)                                                        AS up,
       sum((m.maj = s.y)::int)                                         AS majority_correct,
       sum((CASE WHEN s.dir = 0 THEN m.maj = s.y ELSE (s.dir > 0)::int = s.y END)::int) AS persistence_correct,
       sum((CASE WHEN s.dir = 0 THEN m.maj = s.y ELSE (s.dir < 0)::int = s.y END)::int) AS anti_persistence_correct
FROM folds f
JOIN s ON s.target_year = f.test_year
JOIN majority m ON m.test_year = f.test_year AND m.pair = s.pair
GROUP BY s.pair, f.test_year
ORDER BY s.pair, f.test_year;
