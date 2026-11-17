# Roadmap step 2: real historical data (Dukascopy M1, 2010-2022)

**Outcome:** 19,187,987 real Dukascopy M1 bid/ask bars for EUR/USD, GBP/USD, USD/JPY and
XAU/USD, 2010-2022, imported into TimescaleDB as integer points, compressed 7.5x, with
M5/M15/H1 (UTC) and H4/D1 (New York close) continuous aggregates. Every import check
passes; the data matches FRED's noon New York fixings to a median of 0.40-1.60 pips in
every pair-year and three documented gold extremes to within $2.30. The candles API
serves it with `?source=historical`, and the backtester runs only on it, filling on real
bid/ask at the next bar's open. Along the way the trading core was hardened: market
hours, held exits, derived open P&L, stop-out, typed Kafka contracts, an isolated test
database. 31 commits on `step-2-historical-data` (2026-10-10 to 2026-10-11).

## 1. What the data is

| Item | Value |
|---|---|
| Source | Dukascopy, exported with the official JForex 4 strategy API (`tools/market-data/jforex/`) |
| Pairs | EUR/USD, GBP/USD, USD/JPY, XAU/USD |
| Years | 2010-2022, 52 pair-year CSVs, 2.3 GB, sha256 recorded per file |
| Rows | 27,348,480 minutes in the files; 19,187,987 kept (bid or ask volume > 0) |
| Storage | M1 2,704.6 MB -> 361.5 MB compressed (7.5x, 159 chunks); aggregates 182.7 MB; database 612 MB |
| Import | 14 min 20 s for 2010-2021 (load 7 min, refresh 4 min, checks 2.5 min) + 1 min 16 s for 2022 |

Prices are exact: every source price is a whole number at its decimals (5 for EUR/USD
and GBP/USD, 3 for USD/JPY and gold) and every volume at 6, so they are stored as
integers (`1.08123 -> 108123`) without loss.

## 2. Core concepts

- **Bid, ask, mid, spread.** Buyers pay the ask, sellers get the bid; the spread is the
  difference. Candles store both sides, so fills and stops use the side a real order
  would hit. Charts and indicators use the mid.
- **Pip and point.** A pip is 0.0001 (0.01 for JPY pairs and gold); the data is quoted
  one decimal finer, so one pip = 10 points at every pair's scale.
- **Hypertable and chunks.** TimescaleDB partitions `historical_candles` into 30-day
  chunks; queries and compression work chunk by chunk.
- **Columnstore compression.** Chunks are converted to columnar segments per pair,
  ordered by time. Integers compress by deltas (7.7x on a pair-year); float8 prices
  compressed only 2.9x because decimal fractions are inexact in binary and their noisy
  low bits defeat XOR compression.
- **Continuous aggregates.** Materialized rollups (5m/15m/1h from M1, hierarchical;
  4h from M1, 1d from 4h). Static data: no refresh policies, the importer refreshes them.
- **New York close alignment.** FX days end at 17:00 New York, so H4/D1 bars start at
  17:00 NY (21:00 or 22:00 UTC with DST): 5 daily bars a week instead of 6 UTC ones.
  `time_bucket(..., 'America/New_York', origin => Sunday 17:00)` does it; a child
  aggregate must share its parent's origin, so H4 reads M1, not the UTC H1.
- **Coverage.** `historical_import_log` has one row per imported pair-year (file hash,
  rows, first/last minute, scale); the `historical_coverage` view summarizes it per pair
  and is what the API and the backtester check requests against.
- **Fixing.** A reference rate observed at a set time (FRED H.10: noon New York). Used
  as an independent check of the data, not as data.
- **Look-ahead bias.** A signal computed from a bar's close is only known after the bar
  closes, so it can't trade at that close; it fills at the next bar's open.

## 3. Architectural decisions

| Decision | Why |
|---|---|
| Export through JForex, not dukascopy-node or scraping | Dukascopy's HTTP endpoints sit behind AWS WAF bot protection (dukascopy-node got a 202 challenge and would have returned empty days); the S3 export needs AWS. The official strategy API is the sanctioned route; no workaround against bot protection. |
| Separate `historical_candles` hypertable, explicit `source=live\|historical` | Live mock ticks and real history must never mix in a chart or a backtest. The backtester always reads historical. |
| Integer points + fixed scale per pair (`historical_price_scale`) | 3x smaller compressed than float8, lossless, exact pip arithmetic. The scale is referenced by every import-log row (composite FK), so a pair can't be loaded at two scales and the scale can't change once loaded. |
| COPY into a temporary staging table, validate in SQL, plain INSERT in one transaction with the log row | COPY is the fastest path (3.2 s per pair-year); validation in SQL converts text -> numeric -> integer with no JS float and refuses to round; plain INSERT measured 3.6x faster than ON CONFLICT, and the PK makes a duplicate a loud error. One transaction per pair-year means a crash leaves nothing partial. |
| Idempotency by file hash | A re-run skips pair-years already logged with the same sha256; a changed file stops the run unless `--force`, which decompresses only the overlapping chunks. |
| Year-major order, compress each finished year, aggregates refreshed once | Bounds uncompressed data on a small laptop; compressing aggregates once avoids recompressing the same ~300-day chunks. |
| NY aggregates refreshed in one window padded a week each side | `refresh_continuous_aggregate` skips buckets not fully inside the window; the NY bar of Dec 31 crosses the UTC year (real case: 2012-12-31 22:00-24:00 UTC) and was lost with yearly windows. |
| Checks recompute from M1 independently of the migration SQL | A wrong aggregate definition can't confirm itself; H1/H4/D1 are rebuilt and compared bar for bar. |
| Every check fails on empty input | An empty comparison once read as "identical" (a fingerprint query had failed). |
| Named exceptions for stubs and spot-check failures | Real anomalies (Sunday 16:59 minutes, holiday sessions, off-noon fixings) are listed one by one with evidence; any other or changed failure still fails. Thresholds are never loosened. |
| Next-bar-open fills on bid/ask, SL/TP from the fill bar, SL before TP | Removes look-ahead; models the spread with real quotes; assumes the worse outcome when the order inside a bar is unknown. |
| Derived values never stored (open P&L), relative SQL updates only | Stored copies drifted through lost updates; derived on read they can't. |
| Separate `_test` database per Jest worker | A test that shared the dev DB once stopped out real positions. |

## 4. Database changes (migrations, all under `apps/auth-service/src/migrations/`)

| Migration | Change |
|---|---|
| `1778760074700-Extensions` | `uuid-ossp` and `timescaledb` (the migrations couldn't build an empty database before) |
| `1791626574903-HistoricalCandles` | `historical_candles` hypertable (float8), aggregates, `historical_import_log`, `historical_coverage` (2.1) |
| `1791628621997-InstrumentMetalAndMaxLeverage` | `METAL` instrument type, `instruments.max_leverage` (gold 20) |
| `1791637214598-DeriveAccountOpenPnl` | drop `account_summary.unrealized_pnl` (derived on read), partial indexes on open positions |
| `1791637214599-PositionExitsAndStopOut` | `positions.pending_exit_price/_reason`, `exit_triggered_at`; close reason `STOP_OUT` |
| `1791720000000-HistoricalCandlesIntegerPoints` | rebuilds the (empty) historical schema as int4 prices / int8 volumes; `historical_price_scale`; scale columns + composite FK on the import log; refuses to run up or down while historical rows exist |

Data operations: mock live candles/ticks purged (2.0, backed up first); XAU/USD instrument
row seeded; 7 mock backtest runs and their MinIO results deleted; 7 stale BullMQ jobs
removed; `orders.session_opened` recomputed for 6 orders. No historical row was ever
deleted after import.

## 5. Errors hit, root cause, fix

| Error | Root cause | Fix |
|---|---|---|
| dukascopy-node returned empty days | Dukascopy's HTTP endpoints now answer with an AWS WAF challenge (202) | Export with the JForex strategy API instead; never work around bot protection |
| Spread gate never blocked an order | order-service read `spreadPips`, which the producer never sent; undefined meant "allow"; a fixed 5-pip limit was also wrong for gold | Gate computes the ratio from the traded quote vs `avg_spread` (strictly > 2x, compared at 4 dp) |
| Mock feed spreads disagreed with the DB | Own hardcoded spread map | Feed reads `pip_size`/`avg_spread` from `instruments` |
| Every order stamped OFF_HOURS | Session consumer read a `status` field `forex.sessions` never carried; state lost on restart | Shared pure market clock (`libs/common/market-hours.ts`) |
| Two consumers read fields no producer sent | Consumers cast `JSON.parse` output to an interface | Typed, validating `parse*` contracts per topic with tests on captured messages |
| Order-service tick consumer ~55 s behind | Per-tick queries for every instrument, one message at a time | Batched consumer, per-pair processing, open-pairs index |
| Account `unrealized_pnl` drifted | Fill/close paths wrote back rows read earlier (lost updates) | Relative SQL updates only; open P&L derived on read; invariant monitor |
| Stops lost on restart | Triggered exits kept in memory | `pending_exit_*` committed on the position, retried from the DB |
| LIMIT/STOP orders filled at market | No pending-order engine, but the types were accepted | Rejected until an engine exists; the form shows them as "coming soon" |
| DB test stopped out real positions | The concurrency test ran against the dev DB | Freshly migrated `<DB_NAME>_test` per run (per Jest worker), name guard |
| Migrations couldn't build an empty DB | Extensions existed only because the local DB had them | `Extensions` migration |
| `migration:revert` reverted the wrong migration | TypeORM reverts by execution order, not timestamp | Revert as many times as needed; documented |
| Browser check "passed" on empty values | DOM read returned null, coerced to 0 | Read by label and fail on null; frozen-price exact comparison |
| float8 compressed only 2.9x | Decimal fractions are inexact in binary; noisy low bits | Integer points (7.7x on the spike, 7.5x on the full import) |
| Import-log insert failed: "inconsistent types deduced for parameter $1" | `$1` used as a select value (text) and in WHERE (varchar) | Explicit casts |
| NY H4/D1 bars lost at year boundaries | Refresh only materializes buckets fully inside the window | One padded window for 4h/1d; boundary checks |
| 25 D1 stubs vs "at most 20" | Five real holiday short sessions (New Year's Eve 2012, gold 2012-01-02) | Exact named stub list (20 Sunday + 5 holiday); any other stub fails |
| Holiday classifier accepted a Saturday | Jan 2 2016 fell on a Saturday | Saturdays never allowed (caught by a unit test) |
| Fingerprint "identical" was unverified | `string_agg` over 19M rows hit the 1 GB string limit; the diff compared two empty outputs | Per-pair-year hashes, `ON_ERROR_STOP`, exit code and counts checked; rule: empty input fails |
| Docker vhdx grew 11 GB for 0.56 GB of data | Postgres temp files: the checks spilled ~6 GB per run at the default 4 MB `work_mem` | `work_mem = 256MB` for the importer and checks sessions (0 bytes per check run; 739 -> 123 MB per forced year) |
| Docker reported Kafka at 1.37 GB | Apparent size of sparse, preallocated 10 MB index files (real: 167 MB) | Measure with `du`; documented |
| Nx served a stale cached test result | The daemon's file watcher missed a project directory created after it started | `npx nx daemon --stop`; documented |
| Stale `nx sync` dropped a project reference | Same stale daemon | Fresh daemon, `nx sync` |
| Importer and DB suites collided | Parallel Jest workers dropped and recreated the same test DB | One `_test` database per Jest worker |
| 17 days off FRED by 20-97 pips | The fixing on those days matches our prices hours from noon (e.g. after the 2010-06-23 FOMC statement); our noon bars are complete and normal | Named exceptions with evidence; data unchanged |
| SL/TP checked only on bars with a signal, and on the entry bar's pre-fill range | Simulator iterated signals, not bars | Bar-by-bar simulator; next-bar-open fills |
| London breakout wrong for JPY and gold | Hardcoded `pipSize` default 0.0001 | Pip size from `instruments` via a strategy context |
| Backtest form strategy-name mismatch | Form used `moving_average_crossover` and translated on submit | Backend ids only |
| Backtest page showed pips as dollars and win rate x100 | Display assumed money and a 0-1 ratio | Shows "pips" and the percentage as returned |
| First FRED download reset | Transient, or the custom user agent | Plain retry succeeded; nothing circumvented |

## 6. Validation results

**Import checks (all pass, `npm run data:import -- --check-only`):** rows per pair-year
equal the log (52 pair-years, 19,187,987 rows), one fixed scale per pair, `sum(minutes)`
of every aggregate equals the M1 count, H1/H4/D1 rebuilt from M1 equal the aggregates
(320,863 / 80,977 / 13,533 bars, 0 different), no missing H4/D1 bar within 7 days of
any Jan 1, at most 5 full D1 bars per NY week, exactly the 25 named stubs.

**Idempotency:** re-running is a no-op (0.6 s); `--force EURUSD:2022` with all years
loaded recompressed exactly the 13 chunks overlapping 2022 (of 159) and left M1, every
aggregate and the log identical.

**FRED noon fixings (`npm run data:validate`, report in `docs/validation/historical-spot-checks.md`):**
3,251 days per pair; offset 0 fits better than +-60 minutes in all 39 pair-years
(timezone/DST check); medians 0.40-1.60 pips; 17 named exception days, 1 median exception.
**Gold:** 2011 high, 2015 low and 2020 high match cited spot sources within $0.38-2.30.

**Backtests (`docs/validation/backtest-proof.md`):** MA crossover EUR/USD 2022 H1: 257
trades, -272.2 pips; London breakout: 111 trades, -119.6 pips; MA crossover XAU/USD:
217 trades, -5,559.2 pips. Four trades verified by hand against raw M1 bid/ask.

## 7. Commands cheatsheet

```sh
# Import (idempotent), checks, spot checks
npm run data:import -- --years 2010-2022            # skips pair-years already imported
npm run data:import -- --years 2022 --force EURUSD:2022
npm run data:import -- --dry-run                    # stage and validate, write nothing
npm run data:import -- --check-only
npm run data:validate

# Schema check
docker exec -i forexedge_tsdb psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < tools/market-data/sql/check-historical-schema.sql

# DB integration tests (each Jest worker gets its own <DB_NAME>[_wN]_test)
RUN_DB_TESTS=true npx nx test market-data-import
RUN_DB_TESTS=true npx nx test order-service --testFile=account-consistency.db.spec.ts

# Historical candles API
curl "http://localhost:3002/api/market/candles/EUR_USD/1h?source=historical&from=2022-06-01T00:00:00Z&limit=100"

# Stale backtest jobs (dry run, then apply)
npx ts-node --transpile-only tools/ops/clear-stale-backtest-jobs.ts [--apply]

# Production frontend
npx nx build frontend && npx nx run frontend:serve:production
```

**Compacting Docker's virtual disk** (`docker_data.vhdx` never shrinks by itself; it was
56.7 GB with 17.9 GB used inside). Windows Home has no Hyper-V `Optimize-VHD`, so use
diskpart from an **elevated Command Prompt** (not PowerShell):

```bat
docker builder prune -f
:: Quit Docker Desktop first (tray icon -> Quit), then:
wsl --shutdown
diskpart
  select vdisk file="C:\Users\<you>\AppData\Local\Docker\wsl\disk\docker_data.vhdx"
  attach vdisk readonly
  compact vdisk
  detach vdisk
  exit
```

## 8. Interview Q&A

**Why store prices as integers instead of floats?**
Decimal prices like 1.08123 aren't exactly representable in binary, so float8 columns
carry noisy low bits. TimescaleDB's XOR float compression can't remove noise, so float8
compressed 2.9x; integer points compress by deltas, 7.7x on the same pair-year. It's
also exact: pip math is integer subtraction, and the conversion is lossless because
every source price is whole at its decimals.

**How is the import idempotent and crash-safe?**
Each pair-year loads in one transaction together with its import-log row (file sha256,
row counts). A crash rolls back everything for that pair-year. A re-run skips pair-years
logged with the same hash; a changed file stops the run unless `--force`, which
decompresses only the chunks that overlap that year, deletes and reloads, and replaces
the log row.

**Why not `INSERT ... ON CONFLICT DO NOTHING`?**
It measured 3.6x slower, and it hides problems: a duplicate minute would be skipped
silently. The log decides what gets loaded and the primary key turns an impossible
duplicate into a loud failure.

**What went wrong with refreshing the daily bars?**
`refresh_continuous_aggregate` only materializes buckets entirely inside the window.
New York daily bars start at 22:00 UTC, so the bar holding Dec 31's evening crosses the
UTC year and is never inside a yearly window. Real data had such a bar (EUR/USD traded
22:00-24:00 UTC on 2012-12-31). H4/D1 are refreshed in one window padded a week each
side, and a check compares every bar around each Jan 1 with a rebuild from M1.

**Why can't H4 be built on top of H1?**
A hierarchical continuous aggregate must use its parent's bucket origin. H1 is UTC;
H4/D1 need a New York 17:00 origin, so H4 reads M1 directly and D1 reads H4.

**How do you know the data is correct?**
Two independent sources: FRED's H.10 noon New York fixings for the three FX pairs
(median deviation 0.40-1.60 pips per pair-year, and shifting the comparison by an hour
makes it worse in every pair-year, which proves the timezone and DST handling), and cited
gold extremes. Failures were investigated one by one and recorded as named exceptions
with evidence rather than loosening thresholds.

**How does the backtester avoid look-ahead bias?**
A signal is computed from a bar's close, so it fills at the next bar's open: buys at the
ask open, sells at the bid open. Stops and targets are checked on the fill bar's range
after its open (longs on the bid, shorts on the ask); a gap fills at the open, and if
both levels are inside one bar the stop wins because the order is unknown.

**Why one test database per run, and per worker?**
An integration test that shared the development database once processed fake ticks
against real positions and stopped them out. Tests now drop, create and migrate
`<DB_NAME>_test` and refuse any name not ending in `_test`; parallel Jest workers each
get their own database so suites don't drop each other's.

**Why did Docker's disk grow 11 GB for half a gigabyte of data?**
Postgres temp files. With the default 4 MB `work_mem`, the checks' aggregations over 19M
rows spilled about 6 GB per run; every new block grows the WSL2 virtual disk even after
the file is deleted. Raising `work_mem` for those sessions cut it to zero.

**What does "every check fails on empty input" mean and why?**
A comparison that compared nothing must fail. A fingerprint query once failed silently
(1 GB string limit) and the diff of two empty outputs looked like "identical".

**What was the hardest bug in the trading core?**
Lost updates on the account row: fills and closes read the row, computed new values and
wrote them back, discarding concurrent tick updates. Fixed with relative SQL updates,
deriving open P&L instead of storing it, a per-minute invariant monitor, and a real-DB
concurrency test that fails with the old code.

## 9. Resume keywords

TimescaleDB, hypertables, columnstore compression, continuous aggregates, hierarchical
aggregates, time_bucket with time zones, PostgreSQL COPY, pg-copy-streams, staging
tables, idempotent ETL, data validation, financial time series, bid/ask OHLC, Dukascopy,
JForex, FRED, data quality reconciliation, NestJS, Kafka contracts, BullMQ, MinIO,
TypeORM migrations, integration testing with ephemeral databases, backtesting engine,
look-ahead bias, Nx monorepo, Docker on WSL2.

## 10. Open items

- `docs/OVERNIGHT-QUESTIONS.md`: backtest equity/drawdown/Sharpe are in pips, not money
  (money math, step 3); whether a backtest's To date includes the whole day.
- Step 3: verify backtest metrics, add engine tests beyond the simulator, review the
  pip-based equity curve.
- Step 6: realign the live `candles_4h`/`candles_1d` to the New York close; fix the
  economic-calendar scraper gap.
- Local `main` has 8 unpushed step-2 commits (2.0-2.6) that this branch builds on; the PR
  into `origin/main` contains them.
