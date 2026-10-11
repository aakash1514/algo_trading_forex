-- Independent reproduction of an MA crossover backtest on H1, from the raw M1
-- table only (no continuous aggregates, no TimescaleDB functions, no backtester
-- code). Exact numeric throughout. Rules, as stated in the step-3 plan:
--
--   Bars      H1 rebuilt from historical_candles: open = first minute's open,
--             close = last minute's close (bid and ask); whole UTC days From..To.
--   Signal    side = sign(SMA_fast - SMA_slow) of the mid close, compared exactly
--             as sign(sum_fast(bid_close + ask_close) x slow - sum_slow(...) x fast).
--             Cross above: prev side <= 0 and side > 0; below: prev >= 0 and < 0;
--             a cross in the direction already held is ignored.
--   Fills     at the next bar's open: buy at the ask, sell at the bid; a reversal
--             closes and opens at the same open. A trade still open after the last
--             bar closes at its close (long at the bid, short at the ask).
--   Money     units = lots x instruments.lot_size; commission 14 points round trip;
--             USD = points x units / 10^decimals (USD-quoted) or / exit points
--             (USD-based), cents rounded half away from zero.
--   Equity    marked at every bar close (open trade valued at the bid/ask close,
--             commission deducted, USD-based converted at that close).
--   Sharpe    daily returns at the Mon-Fri New York 17:00 closes, sample stdev,
--             x sqrt(260).
--
-- Parameters: $1 pair, $2 from (timestamptz), $3 end (exclusive), $4 fast,
-- $5 slow, $6 lots, $7 initial capital (USD), $8 commission points.
-- Returns one JSON document: { bars, units, trades: [...], metrics: {...} }.
WITH params AS (
  SELECT $1::text AS pair, $2::timestamptz AS t_from, $3::timestamptz AS t_end,
         $4::int AS fast, $5::int AS slow, $6::numeric AS lots, $7::numeric AS capital, $8::int AS commission
),
spec AS (
  SELECT p.*, s.price_decimals,
         (p.lots * i.lot_size) AS units,
         CASE WHEN split_part(p.pair, '/', 2) = 'USD' THEN 'quote'
              WHEN split_part(p.pair, '/', 1) = 'USD' THEN 'base' END AS usd_leg,
         round(i.pip_size * 10::numeric ^ s.price_decimals) AS pip_points
  FROM params p
  JOIN instruments i ON i.pair = p.pair
  JOIN historical_price_scale s ON s.pair = p.pair
),
h1 AS (
  SELECT date_trunc('hour', c.time, 'UTC') AS b,
         (array_agg(c.bid_open  ORDER BY c.time))[1]      AS bo,
         (array_agg(c.ask_open  ORDER BY c.time))[1]      AS ao,
         (array_agg(c.bid_close ORDER BY c.time DESC))[1] AS bc,
         (array_agg(c.ask_close ORDER BY c.time DESC))[1] AS ac
  FROM historical_candles c, params p
  WHERE c.pair = p.pair AND c.time >= p.t_from AND c.time < p.t_end
  GROUP BY 1
),
bars AS (
  SELECT row_number() OVER (ORDER BY b) AS i, b, bo, ao, bc, ac, (bc + ac)::bigint AS m2 FROM h1
),
sums AS (  -- full windows only are used (i >= slow)
  SELECT b.*, sp.fast, sp.slow,
         sum(m2) OVER (ORDER BY i ROWS BETWEEN ($4::int - 1) PRECEDING AND CURRENT ROW) AS sum_fast,
         sum(m2) OVER (ORDER BY i ROWS BETWEEN ($5::int - 1) PRECEDING AND CURRENT ROW) AS sum_slow
  FROM bars b, spec sp
),
sides AS (
  SELECT i, b, sign(sum_fast * slow - sum_slow * fast) AS side
  FROM sums WHERE i >= slow
),
crosses AS (
  SELECT s.i, s.b,
         CASE WHEN lag(s.side) OVER w <= 0 AND s.side > 0 THEN 1
              WHEN lag(s.side) OVER w >= 0 AND s.side < 0 THEN -1 END AS dir
  FROM sides s
  WINDOW w AS (ORDER BY s.i)
),
kept AS (  -- drop a cross in the direction already held
  SELECT i, dir FROM (
    SELECT i, dir, lag(dir) OVER (ORDER BY i) AS prev_dir FROM crosses WHERE dir IS NOT NULL
  ) x WHERE prev_dir IS DISTINCT FROM dir
),
n AS (SELECT max(i) AS last_i FROM bars),
legs AS (  -- each kept cross opens a trade at the next bar (if there is one)
  SELECT k.i AS signal_i, k.dir, k.i + 1 AS entry_i, lead(k.i) OVER (ORDER BY k.i) + 1 AS next_fill_i
  FROM kept k
),
trades AS (
  SELECT row_number() OVER (ORDER BY l.entry_i) AS k, l.dir,
         l.entry_i,
         CASE WHEN l.next_fill_i IS NOT NULL AND l.next_fill_i <= n.last_i THEN l.next_fill_i ELSE n.last_i END AS exit_i,
         CASE WHEN l.next_fill_i IS NOT NULL AND l.next_fill_i <= n.last_i THEN 'SIGNAL' ELSE 'END_OF_DATA' END AS exit_reason
  FROM legs l, n
  WHERE l.entry_i <= n.last_i
),
priced AS (
  SELECT t.*, e.b AS entry_time, x.b AS exit_time,
         CASE WHEN t.dir = 1 THEN e.ao ELSE e.bo END AS entry_points,
         CASE WHEN t.exit_reason = 'SIGNAL' THEN (CASE WHEN t.dir = 1 THEN x.bo ELSE x.ao END)
              ELSE (CASE WHEN t.dir = 1 THEN x.bc ELSE x.ac END) END AS exit_points
  FROM trades t JOIN bars e ON e.i = t.entry_i JOIN bars x ON x.i = t.exit_i
),
money AS (
  SELECT p.*, sp.units, sp.commission, sp.pip_points,
         p.dir * (p.exit_points - p.entry_points) AS gross_points,
         CASE WHEN sp.usd_leg = 'quote' THEN 10::numeric ^ sp.price_decimals ELSE p.exit_points::numeric END AS denom
  FROM priced p, spec sp
),
trade_rows AS (
  SELECT k, dir, entry_i, exit_i, entry_time, exit_time, entry_points, exit_points, exit_reason, units,
         round(gross_points::numeric / pip_points, 2) AS pips,
         round((gross_points - commission)::numeric / pip_points, 2) AS net_pips,
         round(gross_points * units * 100 / denom) AS gross_cents,
         round((gross_points - commission) * units * 100 / denom) AS net_cents
  FROM money
),
equity AS (  -- marked to market at every bar close, in cents
  SELECT b.i, b.b,
         round(sp.capital * 100)
         + coalesce((SELECT sum(t.net_cents) FROM trade_rows t WHERE t.exit_i <= b.i), 0)
         + coalesce((SELECT round((t.dir * ((CASE WHEN t.dir = 1 THEN b.bc ELSE b.ac END) - t.entry_points) - sp.commission)
                                  * t.units * 100
                                  / (CASE WHEN sp.usd_leg = 'quote' THEN 10::numeric ^ sp.price_decimals
                                          ELSE (CASE WHEN t.dir = 1 THEN b.bc ELSE b.ac END)::numeric END))
                     FROM trade_rows t WHERE t.entry_i <= b.i AND b.i < t.exit_i), 0) AS cents
  FROM bars b, spec sp
),
drawdown AS (
  SELECT max(round((peak - cents) * 100 / peak, 4)) AS max_dd FROM (
    SELECT cents, greatest((SELECT round(capital * 100) FROM spec), max(cents) OVER (ORDER BY i)) AS peak FROM equity
  ) x
),
closes AS (  -- Monday-Friday 17:00 New York, from the calendar
  SELECT ((d + time '17:00') AT TIME ZONE 'America/New_York') AS close_at
  FROM params p,
       LATERAL (SELECT g::date AS d FROM generate_series((p.t_from AT TIME ZONE 'UTC')::date,
                                                         (p.t_end AT TIME ZONE 'UTC')::date, interval '1 day') g) days
  WHERE extract(isodow FROM d) BETWEEN 1 AND 5
),
daily AS (
  SELECT c.close_at,
         coalesce((SELECT e.cents FROM equity e WHERE e.b + interval '1 hour' <= c.close_at ORDER BY e.i DESC LIMIT 1),
                  (SELECT round(capital * 100) FROM spec)) AS cents
  FROM closes c, params p
  WHERE c.close_at >= p.t_from AND c.close_at < p.t_end
),
returns AS (
  SELECT close_at, cents::numeric / lag(cents, 1, (SELECT round(capital * 100) FROM spec)) OVER (ORDER BY close_at) - 1 AS r
  FROM daily
),
stats AS (
  SELECT count(*) AS n_returns, avg(r) AS mean_r, stddev_samp(r) AS sd_r FROM returns
)
SELECT json_build_object(
  'bars', (SELECT count(*) FROM bars),
  'units', (SELECT units FROM spec),
  'trades', coalesce((SELECT json_agg(json_build_object(
      'action', CASE WHEN dir = 1 THEN 'BUY' ELSE 'SELL' END,
      'entryTime', entry_time, 'exitTime', exit_time,
      'entryPoints', entry_points, 'exitPoints', exit_points, 'exitReason', exit_reason,
      'pips', pips, 'netPips', net_pips,
      'grossCents', gross_cents, 'commissionCents', gross_cents - net_cents, 'netCents', net_cents
    ) ORDER BY k) FROM trade_rows), '[]'::json),
  'metrics', json_build_object(
    'totalTrades', (SELECT count(*) FROM trade_rows),
    'netCents', (SELECT coalesce(sum(net_cents), 0) FROM trade_rows),
    'finalEquityCents', (SELECT round(capital * 100) FROM spec) + (SELECT coalesce(sum(net_cents), 0) FROM trade_rows),
    'lastMarkCents', (SELECT cents FROM equity ORDER BY i DESC LIMIT 1),
    'maxDrawdownPct', (SELECT max_dd FROM drawdown),
    'winRate', (SELECT round(100.0 * count(*) FILTER (WHERE net_cents > 0) / nullif(count(*), 0), 2) FROM trade_rows),
    'profitFactor', (SELECT round(sum(net_cents) FILTER (WHERE net_cents > 0)::numeric
                                   / nullif(-sum(net_cents) FILTER (WHERE net_cents < 0), 0), 4) FROM trade_rows),
    'dailyCloses', (SELECT count(*) FROM daily),
    'sharpe', (SELECT CASE WHEN n_returns >= 2 AND sd_r > 0 THEN round(mean_r / sd_r * sqrt(260::numeric), 4) END FROM stats)
  )
) AS result;
