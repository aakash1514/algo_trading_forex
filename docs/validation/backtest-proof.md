# Backtest proof on historical data (step 2.5)

Real runs through the API (auth-service + ws-gateway, BullMQ worker, MinIO results) on
the imported Dukascopy history, 2026-10-11. Simulator rules: a signal fills at the
next bar's open (buy at the ask, sell at the bid); SL/TP are checked from the fill bar
on (long on the bid, short on the ask), gaps fill at the open, SL wins when both are
inside one bar; P&L in pips net of 0.7 pips commission per side.

## Runs

| Strategy | Pair | TF | Range | Trades | Win rate | Profit factor | Sharpe | Max DD* | Net P&L (pips) | Exits |
|---|---|---|---|---|---|---|---|---|---|---|
| MA crossover (10/30) | EUR/USD | 1h | 2022-01-01 .. 2022-12-31 | 257 | 31.52% | 0.9546 | -0.2542 | 10.56% | -272.2 | 256 signal, 1 end of data |
| London breakout | EUR/USD | 1h | 2022-01-01 .. 2022-12-31 | 111 | 50.45% | 0.9672 | -0.2312 | 7.76% | -119.6 | 54 stop, 56 target, 1 end of data |
| MA crossover (10/30) | XAU/USD | 1h | 2022-01-01 .. 2022-12-31 | 217 | 35.94% | 0.9559 | -0.2576 | 93.26% | -5559.2 | 216 signal, 1 end of data |

A run on the old mock-data period (EUR/USD 2026-06-01 .. 2026-06-12) is rejected with
400 "Requested range is outside the historical data for EUR/USD: 2010-01-01T00:00:00.000Z
to 2022-12-30T21:59:00.000Z".

\* Max drawdown is computed by the existing MetricsCalculator on an equity curve that adds
net pips to a 10,000 base, so it scales with a pair's pip count, not with money (gold:
93%). Not changed here; see docs/OVERNIGHT-QUESTIONS.md. Gold's -5559.2 pips is
-$55.59 per ounce traded (pip 0.01).

## Hand-verified trades (raw M1 bid/ask)

Hour bars rebuilt from the raw M1 table (not the aggregates), prices in integer points
(EUR/USD 5 dp, XAU/USD 3 dp). One pip is 10 points.

| # | Trade (as reported) | Raw bars | Check |
|---|---|---|---|
| 1 | MA EUR/USD BUY, entry 2022-01-05 09:00 at 1.13030, exit 2022-01-06 08:00 at 1.12897 (signal), -13.3 pips, net -14.7 | 09:00 bar ask open 113030; 2022-01-06 08:00 bar bid open 112897. SMA10 crosses above SMA30 on the 08:00 bar (1.129143 > 1.129087; 07:00: 1.128972 <= 1.129084) and below on 2022-01-06 07:00 (1.130891 < 1.131146) | entry = next bar's ask open; exit = next bar's bid open; (112897 - 113030) / 10 = -13.3; -13.3 - 1.4 = -14.7 |
| 2 | London EUR/USD SELL, entry 2022-01-03 15:00 at 1.13064, exit 2022-01-12 03:00 at 1.13757 (stop), -69.3 pips | 15:00 bar bid open 113064; stop = Jan 3 Tokyo-session (00:00-08:00) mid high = 113757; the first bar from the fill whose ask high reaches 113757 is 2022-01-12 03:00 (ask open 113722, ask high 113757) | stop touched inside the bar (open below it) -> fills at the level; (113064 - 113757) / 10 = -69.3 |
| 3 | London EUR/USD BUY, entry 2022-01-12 14:00 at 1.14104, exit 15:00 at 1.14237 (target), +13.3 pips | 14:00 bar ask open 114104, bid high 114180; target = Tokyo high 113781 + 2 x (113781 - 113553) = 114237; 15:00 bar bid open 114157, bid high 114251 | target not reached on the fill bar (114180 < 114237), reached inside the next (opens below) -> fills at 114237; (114237 - 114104) / 10 = +13.3 |
| 4 | MA XAU/USD BUY, entry 2022-01-04 17:00 at 1812.805, exit 2022-01-06 02:00 at 1810.068 (signal), -273.7 pips | 17:00 bar ask open 1812805; 2022-01-06 02:00 bar bid open 1810068 | (1810068 - 1812805) / 10 = -273.7 at 3 dp (pip 0.01 = 10 points) |

The verification SQL, run against the dev database:

```sql
\pset footer off
-- Hour bars rebuilt from raw M1 (not the aggregates), mid as the backtester builds it
CREATE TEMP VIEW h1 AS
SELECT pair, time_bucket('1 hour', time) AS b,
       first(bid_open, time) bo, max(bid_high) bh, min(bid_low) bl, last(bid_close, time) bc,
       first(ask_open, time) ao, max(ask_high) ah, min(ask_low) al, last(ask_close, time) ac
FROM historical_candles WHERE time >= '2022-01-01' AND time < '2022-02-01' GROUP BY 1, 2;

\echo '== Trade 1: MA crossover EUR/USD BUY, entry 2022-01-05 09:00, exit 2022-01-06 08:00 (SIGNAL)'
SELECT b AS fill_bar, ao AS entry_ask_open FROM h1 WHERE pair='EUR/USD' AND b='2022-01-05 09:00Z';
SELECT b AS exit_bar, bo AS exit_bid_open FROM h1 WHERE pair='EUR/USD' AND b='2022-01-06 08:00Z';
\echo 'SMA(10) vs SMA(30) of mid close on the signal bars (cross above at 08:00 Jan 5, below at 07:00 Jan 6):'
SELECT b, round(f,6) sma10, round(s,6) sma30, CASE WHEN f > s THEN 'fast>slow' ELSE 'fast<=slow' END AS state FROM (
  SELECT b, avg((bc+ac)/2.0/1e5) OVER w10 f, avg((bc+ac)/2.0/1e5) OVER w30 s
  FROM h1 WHERE pair='EUR/USD' AND b < '2022-01-07'
  WINDOW w10 AS (ORDER BY b ROWS 9 PRECEDING), w30 AS (ORDER BY b ROWS 29 PRECEDING)) x
WHERE b IN ('2022-01-05 07:00Z','2022-01-05 08:00Z','2022-01-06 06:00Z','2022-01-06 07:00Z') ORDER BY b;

\echo '== Trade 2: London breakout EUR/USD SELL, entry 2022-01-03 15:00, exit 2022-01-12 03:00 (STOP_LOSS)'
SELECT b AS fill_bar, bo AS entry_bid_open FROM h1 WHERE pair='EUR/USD' AND b='2022-01-03 15:00Z';
SELECT round(max((bh+ah)/2.0)) AS stop_points_tokyo_high, round(min((bl+al)/2.0)) AS tokyo_low_points
FROM h1 WHERE pair='EUR/USD' AND b >= '2022-01-03' AND b < '2022-01-03 08:00Z';
SELECT b AS first_bar_ask_high_at_or_above_stop, ao, ah FROM h1
WHERE pair='EUR/USD' AND b >= '2022-01-03 15:00Z' AND ah >= 113757 ORDER BY b LIMIT 1;

\echo '== Trade 3: London breakout EUR/USD BUY, entry 2022-01-12 14:00, exit 2022-01-12 15:00 (TAKE_PROFIT)'
SELECT b AS fill_bar, ao AS entry_ask_open FROM h1 WHERE pair='EUR/USD' AND b='2022-01-12 14:00Z';
SELECT round(max((bh+ah)/2.0)) tokyo_high, round(min((bl+al)/2.0)) tokyo_low,
       round(max((bh+ah)/2.0) + (max((bh+ah)/2.0) - min((bl+al)/2.0)) * 2) AS tp_points
FROM h1 WHERE pair='EUR/USD' AND b >= '2022-01-12' AND b < '2022-01-12 08:00Z';
SELECT b, bo, bh FROM h1 WHERE pair='EUR/USD' AND b IN ('2022-01-12 14:00Z','2022-01-12 15:00Z') ORDER BY b;

\echo '== Trade 4: MA crossover XAU/USD BUY, entry 2022-01-04 17:00, exit 2022-01-06 02:00 (SIGNAL)'
SELECT b AS fill_bar, ao AS entry_ask_open FROM h1 WHERE pair='XAU/USD' AND b='2022-01-04 17:00Z';
SELECT b AS exit_bar, bo AS exit_bid_open FROM h1 WHERE pair='XAU/USD' AND b='2022-01-06 02:00Z';
```

## Frontend (production build)

`nx run frontend:serve:production`, headless Chrome, logged in as a test user:

- Form defaults: strategy `ma_crossover`, EUR/USD, 2022-01-01 .. 2022-12-30; options
  `ma_crossover = MA Crossover`, `london_breakout = London Breakout`; date inputs bounded
  2010-01-01 .. 2022-12-30.
- Submitting the defaults: `202 POST /api/backtest/run`; the run appears COMPLETED in the
  table as "MA Crossover | EUR/USD | COMPLETED | -306.7 pips"; metric cards: Net P&L
  -306.7 pips, Win rate 31.5%, Total trades 257, Profit factor 0.95, Sharpe -0.29, Max
  drawdown 10.6%. No console errors (one expected 401 from the session-restore refresh
  before login).
- The UI run differs from the API run above (-306.7 vs -272.2) only in its last trade:
  its To date 2022-12-30 is midnight, so the open trade closes at 2022-12-30 00:00
  instead of 21:00 (256 of 257 trades identical). Whether a To date should include the
  whole day is an open product question.
- Out-of-range dates: the browser blocks the submit (`rangeOverflow`), no request sent.
  A range the browser allows but the API rejects (from after to) shows the API message
  in the form: "fromDate must be before toDate".
