# Research agent backtest tools: data provenance and units (step 5)

`list_backtest_runs` and `get_backtest_run` (`apps/research-agent/src/research_agent/tools/backtests.py`)
return the caller's own COMPLETED runs with the metrics exactly as stored in `backtest_runs`.
There is no date cutoff: the two facts below show that every run that can exist in the current
schema was computed by the verified engine on the imported history.

## 1. The backtest worker reads only the imported history

Verified in the code at the step-5 branch (no file under `apps/ws-gateway/src/backtest` or
`libs/database/src/lib/historical-candles.ts` changed since the step-3 merge `6ed9b23`;
`git log 6ed9b23..HEAD -- <those paths>` is empty).

| Where | What it shows |
|---|---|
| `apps/ws-gateway/src/backtest/backtest.worker.ts:104-116` | Bars are loaded with `requireHistoricalCoverage` (`:110`) and `readHistoricalBars` (`:113`), "always the imported history (never the live candles)" |
| `libs/database/src/lib/historical-candles.ts:17-23` | `HISTORICAL_SOURCES` maps each timeframe to a fixed table: `historical_candles`, `historical_candles_5m/_15m/_1h/_4h/_1d` |
| `libs/database/src/lib/historical-candles.ts:87-100` | `readHistoricalBars` reads `FROM ${source.table}` from that map only; an unknown timeframe throws (`:89`) |
| `apps/ws-gateway/src/backtest/backtest.worker.ts:218` | The only other query on the run path: `SELECT pip_size, lot_size FROM instruments` (contract specs) |
| `apps/ws-gateway/src/backtest/backtest.worker.ts:223-233` | Startup check: the worker refuses to start without the historical tables |
| `grep -rn USE_MOCK_DATA apps/ws-gateway/src` | No match: the backtest path has no mock/live switch at all |
| `grep -rnE "ticks\|candles_(1m\|5m\|15m\|1h\|4h\|1d)\b\|price:\|redis\|kafka" apps/ws-gateway/src/backtest` (excluding specs and `historical_candles`) | Only `backtest-queue.module.ts:21`, BullMQ's job retention in Redis; no tick, live-candle or price-key read |

Strategies, the trade simulator, the money and metrics code take candles as arguments and make
no queries (no `dataSource`, `query` or `fetch` in `strategies/`, `trade.simulator.ts`,
`metrics.calculator.ts`, `trade-money.ts`). The worker moved to the history in `33855d7`
(2026-10-11, "feat(backtest): run on historical bid/ask bars").

## 2. No run from before step 3 can exist in the current schema

`apps/auth-service/src/migrations/1791800000000-BacktestRunMoney.ts`:

- `:10-12`: "Runs made before step 3 have pip-only results that these columns can't describe, so this
  migration refuses to run while any run exists".
- `:18` and `:40-42`: `up()` counts `backtest_runs` and throws if it isn't 0.
- `:22`, `:24`: it adds `initial_capital` and `lots` as `NOT NULL`, which no earlier run had.

So every row in `backtest_runs` was inserted after that migration ran (2026-10-11, commit `d542a97`).
The step-2 runs were backed up and deleted first (step-3 summary). Today the table holds exactly the
4 research demo runs (`tools/ops/research-demo-data.ts`, made at `dbe2cba` with the step-3 engine),
each matched trade by trade by the independent SQL reproduction:
`docs/validation/research-demo-backtests.md`, `docs/validation/research-demo-2-backtests.md`.

There is no non-COMPLETED run in the database, so excluding them is covered only by the
`status = 'COMPLETED'` WHERE clause in both queries (pinned by a test).

## 3. Units of the stored metrics

| Column (scale, `1779798548771-BacktestRuns.ts:21-26` / `BacktestRunMoney.ts`) | Tool field | Meaning, from `apps/ws-gateway/src/backtest/metrics.calculator.ts` | Demo EUR/USD 2022 |
|---|---|---|---|
| `total_trades` integer | `total_trades_count` | trades closed in the window (`:160`) | 257 |
| `win_rate` DECIMAL(5,2) | `win_rate_pct` | % of trades with net USD > 0, 0-100, 2 dp (`:23`, `:161`) | 31.52 |
| `profit_factor` DECIMAL(8,4) | `profit_factor_ratio` | gross profit / gross loss of net USD, 4 dp, null without a loss (`:22`, `:162`) | 0.9546 |
| `sharpe_ratio` DECIMAL(8,4) | `sharpe_ratio` | daily NY-close simple returns, mean / sample stdev x sqrt(260), rf 0, 4 dp (`:16-21`, `:131-142`, `:163`) | -0.2145 |
| `max_drawdown_pct` DECIMAL(8,4) | `max_drawdown_pct` | max (peak - equity) / peak x 100 of marked-to-market USD equity; **positive** (a fall, never negative), can exceed 100 (`:12-15`, `:119-128`, `:164`) | 11.1369 |
| `total_pnl` DECIMAL(12,2) | `total_pnl_pips` | net pips after commission (`:38`, `:165`; `trade.simulator.ts:134`; column comment "Net P&L in pips") | |
| `total_pnl_usd` NUMERIC(14,2) | `total_pnl_usd` | net USD, 2 dp (`:39`, `:166`; column comment "Net P&L in USD") | -272.20 |
| (derived) | `final_equity_usd` | `initial_capital + total_pnl_usd`, not stored (CLAUDE.md) | 9727.80 |

The worker writes these with `...metrics` (`backtest.worker.ts:192`). The demo values match the
step-3 verification table (`docs/validation/backtest-verification.md`) for the same inputs.

## 4. Access

- Every query has `user_id = <caller>` in its WHERE clause; another user's run is `NOT_FOUND`.
  Tested both ways between `research_demo` and `research_demo_2`.
- The DB login can't read `minio_object_key`, `error_message` or `progress` (column grants,
  migration `ResearchReadRole`); the tools never return them.
- A user without runs gets `{"runs": [], "runs_count": 0, "note": ...}`.
