-- Independent reproduction of get_market_stats in SQL (numeric arithmetic, window functions),
-- for tests/test_tools_data.py. {table} is substituted from a fixed map (historical_candles_1h/_4h/_1d);
-- parameters: pair, window start (inclusive), last whole-bar bucket (inclusive).
-- Values are in twice-the-mid integer points (bid + ask), like the bars themselves.
WITH b AS (
  SELECT bucket,
         (bid_open + ask_open)::numeric   AS o2,
         (bid_high + ask_high)::numeric   AS h2,
         (bid_low + ask_low)::numeric     AS l2,
         (bid_close + ask_close)::numeric AS c2,
         (ask_close - bid_close)::numeric AS spread
  FROM {table}
  WHERE pair = %(pair)s AND bucket >= %(start)s AND bucket <= %(last)s
),
first_bar AS (SELECT o2 FROM b ORDER BY bucket LIMIT 1),
last_bar AS (SELECT c2 FROM b ORDER BY bucket DESC LIMIT 1),
hi AS (SELECT h2, bucket FROM b ORDER BY h2 DESC, bucket LIMIT 1),
lo AS (SELECT l2, bucket FROM b ORDER BY l2 ASC, bucket LIMIT 1),
log_returns AS (SELECT ln(c2 / lag(c2) OVER (ORDER BY bucket)) AS r FROM b),
peaks AS (
  SELECT c2, greatest((SELECT o2 FROM first_bar), max(c2) OVER (ORDER BY bucket ROWS UNBOUNDED PRECEDING)) AS peak
  FROM b
)
SELECT
  (SELECT count(*) FROM b)                                   AS bars,
  (SELECT min(bucket) FROM b)                                AS first_bucket,
  (SELECT max(bucket) FROM b)                                AS last_bucket,
  (SELECT o2 FROM first_bar)                                 AS first_o2,
  (SELECT c2 FROM last_bar)                                  AS last_c2,
  ((SELECT c2 FROM last_bar) - (SELECT o2 FROM first_bar)) / (SELECT o2 FROM first_bar) * 100 AS return_pct,
  (SELECT count(*) FROM b WHERE c2 > o2)                     AS up_bars,
  (SELECT count(*) FROM b WHERE c2 < o2)                     AS down_bars,
  (SELECT count(*) FROM b WHERE c2 = o2)                     AS flat_bars,
  (SELECT h2 FROM hi)                                        AS high_h2,
  (SELECT bucket FROM hi)                                    AS high_bucket,
  (SELECT l2 FROM lo)                                        AS low_l2,
  (SELECT bucket FROM lo)                                    AS low_bucket,
  (SELECT avg(h2 - l2) / 2 FROM b)                           AS avg_range_points,
  (SELECT avg(spread) FROM b)                                AS avg_spread_points,
  (SELECT stddev_samp(r) * 100 FROM log_returns)             AS vol_per_bar_pct,
  (SELECT max((peak - c2) / peak) * 100 FROM peaks)          AS max_drawdown_pct
