# Roadmap step 3: backtest verification

**Outcome:** backtests report money, not pips. Every trade carries its USD P&L
(lots x `instruments.lot_size`, USD/JPY converted at the trade's own exit fill), and
equity, drawdown and Sharpe come from a USD equity curve marked to market at every bar
close. The To date is inclusive, the MA crossover compares its averages exactly, and the
old pip-only runs were backed up and deleted. The step's actual verification: an
independent SQL reproduction, built from the raw M1 table without the backtester's code
or the continuous aggregates, matches the backtester's API runs **trade by trade and
metric by metric**: EUR/USD 257 of 257 trades, XAU/USD 217 of 217, USD/JPY 215 of 215
(MA crossover 10/30, H1, 2022). 8 feature commits plus this close-out on
`step-3-backtest-verification` (2026-10-11).

## 1. What changed

| Area | Before | After |
|---|---|---|
| Trade P&L | Pips only | Pips plus units, gross/commission/net USD (whole cents) |
| Position size | `lots` sent to the strategies, not stored | `lots` and `initial_capital` validated and stored on every run |
| Equity curve | 10,000 + net pips per closed trade | USD, marked to market at every bar close |
| Max drawdown | % of the pip curve (gold 93%) | % of peak USD equity (gold 23.6%) |
| Sharpe | Per-trade pips x √252, 0 when undefined | Daily returns at Mon-Fri NY 17:00 closes x √260, null when undefined |
| Profit factor | Pips; 999 without a loss | USD; null without a loss |
| To date | An instant: "To 2022-12-30" stopped at 00:00 | Inclusive calendar day; whole bars only |
| MA crossover | Float SMAs | Exact integer sums (no near-ties) |
| Old runs | 5 pip-only runs | Backed up (rows, results, sha256 manifest) and deleted |
| ws-gateway tests | 5 suites, `passWithNoTests` | 10 suites, 98 tests; `passWithNoTests` removed |
| Verification | Hand-checked 4 trades (step 2) | Every trade of 3 runs reproduced independently, exact |

## 2. Core concepts

- **Units and lot size.** A lot is a contract size from `instruments.lot_size`: 100,000
  units for FX, 100 oz for XAU/USD. Units = lots x lot size. 0.1 lot of EUR/USD is
  10,000 euros; 0.1 lot of gold is 10 oz.
- **P&L in the quote currency, then USD.** A price move times units is money in the
  pair's quote currency. EUR/USD and XAU/USD are quoted in USD, so that is already USD.
  USD/JPY is quoted in yen: divide by the USD/JPY price to get dollars.
- **Exact money from integer points.** Prices are stored as integer points (step 2), so
  `usd = points x units / 10^decimals` (USD-quoted) or `points x units / exitPoints`
  (USD-based: the 10^decimals of the yen amount and of the rate cancel). Each amount is a
  fraction of integers, rounded once to cents with BigInt, half away from zero, the same
  rule as Postgres `round(numeric)`.
- **Pip value.** The USD value of one pip for the position: units x pip size x
  quote->USD. At 0.1 lot: EUR/USD $1, XAU/USD $0.10, USD/JPY 10,000 x 0.01 / price
  (about $0.87 at 115). The step-2 pip totals therefore predict the USD totals of the
  USD-quoted runs exactly (-272.2 pips -> -$272.20; -5,559.2 pips -> -$555.92).
- **Mark to market.** Equity at a moment = cash + what the open position would bring if
  closed now. A long closes at the bid, a short at the ask, and the round-trip
  commission is paid either way. Marking only at trade closes hides the losses of a
  trade while it is open, so the drawdown would be understated.
- **Max drawdown.** The largest fall from a running peak, as a % of that peak. The peak
  starts at the initial capital, so a run that loses from the first bar still shows its
  drawdown.
- **Sharpe ratio.** Mean / standard deviation of periodic returns, annualized by √(periods
  per year). Here: daily simple returns of the marked equity at each Monday-Friday New
  York 17:00 close (the FX day ends at 17:00 New York), sample standard deviation,
  √260 (52 weeks x 5 days), risk-free rate 0. Days come from the calendar, not from D1
  bars, so holidays count as 0-return days and the Sunday stub bars add no days.
- **Inclusive date window, whole bars.** From and To are calendar days in UTC. The window
  is [From 00:00, the day after To 00:00), and a bar is used only when it lies entirely
  inside (bucket + timeframe <= end). That keeps the New York-aligned D1/H4 bars honest:
  the D1 bar starting Wednesday 17:00 New York is Thursday's data and is excluded when To
  is Wednesday.
- **Exact indicator comparisons.** Mid = (bid + ask) / 2, so 2 x mid = bid + ask is a
  whole number of points. SMA_fast > SMA_slow  <=>  sum_fast x slow > sum_slow x fast,
  an integer comparison with no rounding.
- **Differential testing.** Verify a system by building a second, independent
  implementation from the specification and comparing outputs on real input. The two
  share only the stated rules and the raw data, so a bug has to be made twice, in two
  languages, to go unnoticed.

## 3. Architectural decisions

| Decision | Alternatives | Why |
|---|---|---|
| Money from integer points, BigInt, half away from zero | Float dollars, `toFixed` | Exact and reproducible: the SQL's `round(numeric)` gives the same cent; float `Math.round` rounds negative halves toward +infinity |
| USD/JPY converted at the exit fill | Mid of the exit bar's close | It is the real rate on the exit bar and is exactly reproducible; conversion spread not modelled (documented) |
| Equity marked at every bar close | Only at trade closes | Captures open-trade drawdown; the cost is a per-bar valuation that the SQL also reproduces |
| Sharpe on calendar NY closes, √260 | D1 bars, √252 | D1 bars include 25 stub bars that would create extra days; 260 fits FX's 5-day week |
| Null for undefined metrics | 0 or 999 sentinels | A fabricated number reads as a result; null shows as "—" in the UI |
| `initial_capital` and `lots` NOT NULL; migration refuses while runs exist | Nullable columns, a legacy UI path | Every run has its inputs; no second code path for pip-only rows (user decision: back up and delete) |
| Final equity derived, not stored | A column | Project rule: never store derived columns |
| Dates as `YYYY-MM-DD` only | Accept timestamps | An instant can't express "the whole day"; the DTO rejects timestamps and 2022-02-30 instead of normalising |
| One window helper for service and worker | Each computes its own range | Validation, coverage check and bar range can't disagree |
| Exact SMA in the strategy | Tolerance in the comparison | A tolerance would hide real disagreements; exact on both sides means any difference is a bug |
| Verification SQL in plain PostgreSQL on raw M1 | Reuse the aggregates or the backtester modules | Independence: no shared code, no shared aggregates; `array_agg` first/last instead of TimescaleDB `first()`/`last()` |
| Verification through the real API | Call the worker in-process | Proves the deployed path: DTO validation, queue, worker, MinIO results |

## 4. Database changes

Migration `apps/auth-service/src/migrations/1791800000000-BacktestRunMoney.ts`:

```sql
ALTER TABLE backtest_runs
  ADD COLUMN initial_capital NUMERIC(14,2) NOT NULL
    CONSTRAINT backtest_runs_initial_capital_check CHECK (initial_capital BETWEEN 100 AND 10000000),
  ADD COLUMN lots            NUMERIC(8,2)  NOT NULL
    CONSTRAINT backtest_runs_lots_check CHECK (lots BETWEEN 0.01 AND 100),
  ADD COLUMN total_pnl_usd   NUMERIC(14,2) NULL;
COMMENT ON COLUMN backtest_runs.total_pnl IS 'Net P&L in pips';
COMMENT ON COLUMN backtest_runs.total_pnl_usd IS 'Net P&L in USD';
```

- `up()` and `down()` refuse while `backtest_runs` has rows; `migration:revert` then
  `migration:run` was checked on the empty table.
- Data: the 5 pip-only step-2 runs were backed up by `tools/ops/purge-pip-backtest-runs.ts`
  to `data/backups/backtest-runs/2026-10-11T06-23-08-267Z/` (rows JSON, 5 results files,
  sha256 manifest, every file read back and re-hashed) and deleted with their MinIO
  objects; their 5 BullMQ jobs were removed with `clear-stale-backtest-jobs.ts`.
- Close-out: the 4 throwaway users created by the verification and UI checks
  (`verify_*`, `ui_*`) were deleted with their 6 runs, results objects and jobs (they had
  no orders, positions or accounts). The run ids in `docs/validation/backtest-verification.md`
  refer to those deleted runs; re-run `npm run backtest:verify` to reproduce.
- No change to the historical tables.

## 5. Errors hit, root cause, fix

| Error | Root cause | Fix |
|---|---|---|
| MA crossover signalled a bar early on a real tie (EUR/USD 2022-01-03 12:47, SMA 5/20) | Float SMAs: 1,135,041 / 5 and 4,540,164 / 20 are equal, but summing float mids put fast below slow | Integer prefix sums of bid + ask points, cross-multiplied; the spec fails on the old code (3 tests) |
| "To 2022-12-30" left out that whole day (UI run -306.7 pips vs API -272.2) | `toDate` was an instant (midnight) and the reader includes bars starting at or before it, so the last bar was 00:00 | Calendar days, window ends at the next midnight, whole bars only; To = 2022-12-30 now reproduces the step-2 API run trade for trade |
| Drawdown 93% on gold, 10.6% on EUR/USD for similar strategies | Equity curve added pips to 10,000; a gold pip is 10 x smaller in money per point moved | USD equity from lot size; gold now 23.6% |
| Sharpe 0 and profit factor 999 on runs that couldn't compute them | Sentinels in place of "undefined" | null, shown as "—" |
| `TS2737: BigInt literals are not available when targeting lower than ES2020` | ws-gateway inherited `target: es2015` from tsconfig.base | `target: es2021` in ws-gateway app/spec tsconfigs (as order-service) |
| Lint `no-useless-escape` in the new jest config | A shell heredoc turned `\\.` into `\.` | Line copied from the working config (same error as step 2) |
| Metrics spec crashed: `Cannot read properties of undefined (reading 'bucket')` | The test signalled on 2013-01-01 21:59, but New Year's Day has no traded minute before 22:00 in the real fixture | Signals on minutes that exist; the holiday became a test of the daily sampling |
| Metrics spec expected profit factor null for one losing trade | Wrong expectation: no profit and a loss is 0, null is for no loss | Expectation corrected |
| Results upload size | `resultsJson.length` counts UTF-16 code units, not bytes | `Buffer.byteLength` |
| ws-gateway "passed" with no specs | `passWithNoTests: true` | Removed; the project now has 98 tests |
| Headless login didn't leave /login | The form was filled before React hydrated, so the inputs had no handlers | Wait for React props on the input before filling |
| DB test "refuses to revert the integer layout" failed in the close-out | It reverted "the last migration" and expected the step-2 guard; BacktestRunMoney is now last and reverts on an empty table | The test walks the migrations down by name: BacktestRunMoney refuses with a run present, reverts without, then the integer layout refuses (also covers the new guard) |
| Scratch script: `Cannot find module 'pg'` | Run from the scratch directory, outside the repo's node_modules | `NODE_PATH=<repo>/node_modules` |

## 6. Verification results

`npm run backtest:verify -- --pairs EUR_USD,XAU_USD,USD_JPY` (MA crossover 10/30, H1,
2022-01-01 to 2022-12-30 inclusive, 0.1 lot, $10,000), backtester / SQL:

| Pair | Bars | Trades | Net USD | Final equity | Max DD | Sharpe | Win rate | Profit factor |
|---|---|---|---|---|---|---|---|---|
| EUR/USD | 6,240 | 257 / 257 | -272.20 / -272.20 | 9,727.80 / 9,727.80 | 11.1369% / 11.1369% | -0.2145 / -0.2145 | 31.52 / 31.52 | 0.9546 / 0.9546 |
| XAU/USD | 5,915 | 217 / 217 | -555.92 / -555.92 | 9,444.08 / 9,444.08 | 23.6017% / 23.6017% | -0.1188 / -0.1188 | 35.94 / 35.94 | 0.9559 / 0.9559 |
| USD/JPY | 6,240 | 215 / 215 | 1,485.75 / 1,485.75 | 11,485.75 / 11,485.75 | 6.2725% / 6.2725% | 1.4623 / 1.4623 | 36.74 / 36.74 | 1.3128 / 1.3128 |

Every trade matches on entry/exit time, entry/exit points, exit reason, pips, net pips,
and gross/commission/net cents. Full tables: `docs/validation/backtest-verification.md`.
Other checks (`docs/validation/step-3-checks.md`): the inclusive To date reproduces the
step-2 runs with 0 differing trades; the exact SMA changed none of these 2022 H1 trades;
the backtest page works in the production build (form, hint, USD metrics, Sharpe
tooltip).

Hand-worked examples (0.1 lot, real H1 bid/ask, in `trade-money.spec.ts`):

| Pair type | Trade | Net points | Net USD |
|---|---|---|---|
| EUR/USD | buy at ask open 113030, sell at bid open 112897 | -133 - 14 = -147 | -147 x 10,000 / 10^5 = -$14.70 |
| USD/JPY | buy at ask open 114929, sell at bid open 115471 | 542 - 14 = 528 | 528 x 10,000 / 115,471 = $45.7258 -> $45.73 |
| XAU/USD | buy at ask open 1812805, sell at bid open 1810068 | -2,737 - 14 = -2,751 | -2,751 x 10 / 10^3 = -$27.51 |

Close-out clean matrix (`nx reset`, `dist/` deleted, lint, typecheck, test, build for
all 16 projects): see section 10.

## 7. Commands cheatsheet

```sh
# Independent verification (auth-service :3000 and ws-gateway :3005 running)
npx nx build auth-service && node dist/apps/auth-service/main.js
npx nx build ws-gateway && node dist/apps/ws-gateway/main.js
npm run backtest:verify -- --pairs EUR_USD,XAU_USD,USD_JPY --from 2022-01-01 --to 2022-12-30
# optional: VERIFY_EMAIL / VERIFY_PASSWORD to log in instead of registering a fresh user

# Back up and delete pip-only runs (dry run, then apply), then their BullMQ jobs
npx ts-node --transpile-only tools/ops/purge-pip-backtest-runs.ts [--apply]
npx ts-node --transpile-only tools/ops/clear-stale-backtest-jobs.ts [--apply]

# Migration
npm run migration:run

# Tests
npx nx test ws-gateway --testFile=trade-money.spec.ts
npx nx test ws-gateway --testFile=metrics.calculator.spec.ts
npx nx test ws-gateway --testFile=ma-crossover.strategy.spec.ts
npx nx test backtest-verify

# Submit a run directly (dates are inclusive calendar days)
curl -X POST localhost:3005/api/backtest/run -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"strategyName":"ma_crossover","instrument":"EUR_USD","timeframe":"1h","fromDate":"2022-01-01",
       "toDate":"2022-12-30","parameters":{"fastPeriod":10,"slowPeriod":30},"lots":0.1,"initialCapital":10000}'

# Production frontend
npx nx build frontend && npx nx run frontend:serve:production
```

## 8. Interview Q&A

**How do you know the backtester is right?**
I reimplemented it independently: one SQL query rebuilds H1 bars from the raw minute
data, computes the moving averages, finds the crossovers, fills at the next bar's open on
bid/ask, and computes pips, dollars, the marked equity, drawdown and Sharpe in exact
numeric. A script submits the same backtest through the real API and compares every
field of every trade. EUR/USD, gold and USD/JPY for 2022 match exactly: 689 trades, every
cent and every metric. The two share only the written rules and the raw data.

**Why did the SMA have to be made exact?**
Because "exact match" is only meaningful if both sides are exact. Float averages differ
in the last bits depending on summation order, and the crossover rule compares them with
`<=`, so a true tie can land either way. That happened on real data: EUR/USD 2022-01-03
12:47, SMA 5/20, the two sums are exactly equal, but the float version said fast < slow
and signalled a bar early. Doubling the mid (bid + ask) makes every price an integer, and
cross-multiplying the sums makes the comparison an integer comparison.

**How do you value a USD/JPY trade in dollars?**
The P&L is in yen: points x units / 1,000 at 3 decimals. To get dollars, divide by the
USD/JPY rate, which is exitPoints / 1,000, so the factors cancel:
usd = points x units / exitPoints. I convert at the trade's exit fill because that is the
rate on the exit bar and it's reproducible; the spread on converting yen isn't modelled.

**Why mark to market at every bar instead of at trade closes?**
A trade that falls 5% and recovers before closing would show no drawdown if equity only
moved at closes. Marking at every bar close, at the price you'd actually get (bid for a
long, ask for a short, after commission), measures the real worst case. On the exit bar
the marked equity equals the realized equity, so the curve is continuous.

**Why is the Sharpe computed on daily returns at the New York close, with √260?**
Sharpe needs regular periods; per-trade returns have random spacing and annualizing them
with √252 is meaningless. FX's trading day ends at 17:00 New York, so equity is sampled at
the last bar closing at or before each Monday-Friday 17:00 New York, taken from the
calendar so that holiday stub bars don't create days. There are 5 such closes in each of
52 weeks, hence √260.

**What is a whole-bar inclusive window, and why does it matter for daily bars?**
"To = Wednesday" should include all of Wednesday and nothing after it. The window is
[From 00:00, Thursday 00:00) UTC, and a bar counts only if it ends inside it. The New
York-aligned daily bar that starts Wednesday 17:00 New York (21:00 UTC) is almost all
Thursday's data; including it because it *starts* before the cut-off would leak the
future into the backtest.

**How do you avoid rounding drift in money?**
Every amount is a fraction of integers (points x units x 100 / denominator), rounded once
to whole cents with BigInt, half away from zero. Totals are sums of cents. Postgres
`round(numeric)` uses the same rule, which is why the SQL agrees to the cent.

**Why delete the old runs instead of keeping them?**
Their drawdown and Sharpe were computed on pips and can't be converted afterwards (there
was no capital or size). Keeping them would need a second UI path for a metric that is
wrong. They were backed up with checksums first, and the migration refuses to run while
any run exists, so nothing can be dropped by accident.

**What does "every check fails on empty input" mean here?**
The comparison fails if either side has zero bars or zero trades, and on any count
difference. A verification that compares two empty lists would otherwise pass.

## 9. Resume keywords

Backtesting engine, differential testing, independent verification, exact decimal
arithmetic, BigInt, integer fixed-point money, mark-to-market equity, maximum drawdown,
Sharpe ratio annualization, FX pip value and quote-currency conversion, bid/ask fills,
look-ahead bias, PostgreSQL window functions, numeric precision, TimescaleDB, NestJS,
class-validator custom decorators, BullMQ, MinIO, TypeORM migrations with safety guards,
data backup with checksums, Next.js, React Hook Form, Zod, headless Chrome (DevTools
protocol), Nx monorepo, Jest.

## 10. Close-out

- Clean matrix: `npx nx reset`, `dist/` deleted, `npx nx run-many -t lint typecheck test build --parallel=2`:
  all 16 projects pass (7 min 4 s); lint 0 errors, 42 warnings, all on lines that predate step 3.
- Tests: 556 pass in the matrix, plus the 23 DB integration tests run with `RUN_DB_TESTS=true`
  (market-data-import 22, order-service 1): **579 passing, 0 failing**. New this step: ws-gateway 98
  (from 36), backtest-verify 6, frontend 43 (from 39).
- Throwaway users deleted (4 users, 6 runs, 6 results objects, their jobs; 0 orders,
  positions or accounts).
- `docs/OVERNIGHT-QUESTIONS.md`: both step-2 questions marked resolved.

## 11. Open items

- London breakout (stop-loss/take-profit path) has no independent reproduction yet; MA
  crossover has. Each new strategy needs one before its results are trusted.
- Not modelled in backtests: margin and stop-out (equity can go below zero), the spread
  on converting JPY P&L to USD, swaps, slippage beyond the bar's bid/ask.
- Pairs without a USD leg (e.g. EUR/GBP) are rejected; valuing them needs the conversion
  pair's history.
- Sharpe is compared at 4 dp between JS doubles and Postgres numeric; it matched for all
  three runs, but it is the one metric that isn't exact by construction (square root).
