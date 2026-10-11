# Overnight report (2026-10-11)

Unattended run from the 2.4 approval to the end of roadmap step 2. Everything is on
branch `step-2-historical-data` (pushed); `main` was not touched, nothing was
force-pushed, no historical data was deleted or rewritten, no check was loosened.

## Status at a glance

| Item | Result |
|---|---|
| 2.4 named exceptions | Done: 17 investigated days + EUR/USD 2010 median; `npm run data:validate` exits 0 only with exactly those |
| 2.5 commit 1: `?source=historical` | Done, verified against the running service (200 / 404 / 422 / 400 cases) |
| 2.5 commit 2: backtester on historical bid/ask, next-bar-open fills | Done, simulator tests on real bars |
| 2.5 commit 3: strategy ids, form defaults | Done |
| Stale BullMQ jobs | 7 removed (all from deleted mock runs); queue empty |
| 2.5 proof: MA + London on EUR/USD 2022 H1, XAU/USD run | Done: non-zero trades and metrics; 4 trades hand-verified (`docs/validation/backtest-proof.md`) |
| Backtest page, production build | Done (and fixed two display bugs it revealed) |
| Full clean matrix | Pass: lint (0 errors), typecheck, test, build for all 15 projects from an empty `dist/` |
| Phase summary, CLAUDE.md | Done |
| **Pull request** | **Not opened: the GitHub CLI is not installed** (see below) |

## Tests

Clean matrix (`nx reset`, `dist/` deleted, no cache hits, 38 tasks, 6 min 20 s):

| Project | Tests |
|---|---|
| common | 83 |
| order-service | 194 (+1 DB test) |
| market-service | 47 |
| market-data-import | 43 (+22 DB tests) |
| frontend | 39 |
| ws-gateway | 36 |
| domain-service | 21 |
| kafka | 9 |
| database | 8 |
| auth-service | 4 |
| **Total** | **484 unit + 23 DB (`RUN_DB_TESTS=true`) = 507, all passing** |

Lint: 0 errors, 59 warnings (pre-existing kinds; the backtest folder went from 6 to 1).

## Backtest results (EUR/USD and XAU/USD, 2022, H1, through the real API)

| Strategy | Pair | Trades | Win rate | Profit factor | Net P&L |
|---|---|---|---|---|---|
| MA crossover 10/30 | EUR/USD | 257 | 31.52% | 0.95 | -272.2 pips |
| London breakout | EUR/USD | 111 | 50.45% | 0.97 | -119.6 pips |
| MA crossover 10/30 | XAU/USD | 217 | 35.94% | 0.96 | -5,559.2 pips (-$55.59/oz) |

Hand-verified against raw M1 bid/ask (entry, exit, P&L all exact): an MA signal trade,
a London stop-loss (touched inside the bar, filled at the level), a London take-profit,
and a gold trade. The old mock-data period is rejected with 400 naming the covered range.

## Things found and fixed along the way

- Simulator checked SL/TP only on bars carrying a signal, and on the entry bar's pre-fill
  range; now bar by bar from the fill bar (with the next-bar-open rule you specified).
- London breakout assumed pip 0.0001 for every pair (wrong for USD/JPY and gold); pip size
  now comes from `instruments`.
- Backtest form: strategy-name translation removed, defaults moved from the mock period
  to 2022, dates bounded to the history, API errors shown instead of silently dropped.
- Backtest page showed pips as dollars and the win rate x100 (3152%).
- `nx start frontend` can't find the dist build; the working command is in CLAUDE.md.

## Open items

- **Pull request.** `gh` is not installed and I did not extract your GitHub token from the
  credential manager to call the API. Open it from:
  https://github.com/aakash1514/algo_trading_forex/compare/main...step-2-historical-data?expand=1
  with the title and description below (or `gh pr create --base main --head
  step-2-historical-data --title "..." --body-file <file>` once gh is installed). Note:
  local `main` has 8 step-2 commits (2.0-2.6) that were never pushed; the branch contains
  them, so the PR shows all 31 step-2 commits against `origin/main`.
- `docs/OVERNIGHT-QUESTIONS.md`: (1) backtest equity/drawdown/Sharpe are computed on pips
  added to a 10,000 base, so drawdown % depends on the pair's pip count (gold 93%):
  valuing trades in money changes money math, so it was not changed; (2) whether a
  backtest's To date should include that whole day.
- Docker's `docker_data.vhdx` is ~56.7 GB with ~17.9 GB used inside; compaction steps are
  in the phase summary (needs Docker quit and an elevated Command Prompt).

## Commits (`origin/main..step-2-historical-data`, oldest first)

| Commit | Subject |
|---|---|
| `ade7b43` | feat(market-data): JForex M1 bid/ask export strategy for step 2 |
| `74376b0` | chore(data): purge mock live candles and ticks before the historical import |
| `d218063` | feat(db): historical_candles hypertable and NY-close aggregates |
| `e889af3` | fix(orders): spread gate judges the traded quote against avg_spread |
| `243ddf2` | feat(instruments): XAU/USD row, METAL type and per-instrument leverage cap |
| `0f5b576` | feat(market): mock feed quotes from instruments pip_size and avg_spread; add XAU/USD |
| `761a3a3` | fix(positions): tick P&L update can no longer rewrite a closed position |
| `39434b8` | feat(frontend): XAU/USD and the four historical pairs; price precision per pair |
| `e0a4499` | perf(orders): batched tick consumer keeps up with the feed |
| `1e653d7` | feat(common): shared market clock (market hours and trading sessions) |
| `68360cd` | feat(kafka): typed, validated contracts for every topic |
| `6db8f7c` | fix(orders): clock-based session stamps, no lost stops, no lost account updates |
| `4474048` | chore(ops): one-off script to recompute orders.session_opened |
| `7fd4b29` | feat(db): derive account open P&L; persist held exits; STOP_OUT close reason |
| `cd025ca` | feat(orders): market hours, held exits, derived open P&L, stop-out, SL/TP edits |
| `9818712` | feat(market): mock feed is silent while a market is closed; keep last price |
| `82981c5` | docs: 2.7c notes; mark forex.calendar-events not built; drop date-fns-tz |
| `4d1edaa` | test(db): integration tests run in a separate, freshly migrated _test database |
| `7e85f6a` | feat(frontend): order form shows Limit/Stop/OCO as coming soon |
| `8b7cbe3` | feat(db): historical candles as integer points with a fixed scale per pair |
| `4d6d270` | feat(market-data): idempotent historical M1 importer with real-data checks |
| `60c4579` | feat(market-data): vacuum (analyze) M1 and the aggregates after an import |
| `7d973f9` | feat(market-data): exact D1 stub list; checks and refreshes stop spilling to disk |
| `e687584` | feat(market-data): spot checks against FRED noon fixings and gold extremes (2.4) |
| `d48999a` | feat(market-data): named exceptions for the FRED spot check; 2.4 passes |
| `7a709f4` | feat(market): ?source=historical on the candles API via a shared historical reader |
| `33855d7` | feat(backtest): run on historical bid/ask bars; fills at the next bar's open |
| `e5f7e85` | chore(ops): remove stale BullMQ backtest jobs whose runs no longer exist |
| `ccc740a` | fix(frontend): backtest form uses the backend strategy ids and the history's dates |
| `e64cba9` | fix(frontend): backtest page shows P&L in pips and the win rate as returned |
| `6f5b5dd` | docs: 2.5 backtest proof on historical data; overnight questions |
| `d8c5e9a` | docs: complete roadmap step 2; phase summary and CLAUDE.md updates |

## Pull request text (ready to paste)

**Title:** Roadmap step 2: real Dukascopy history (2010-2022), validation, historical backtests

**Description:**

Imports 19,187,987 real Dukascopy M1 bid/ask bars (EUR/USD, GBP/USD, USD/JPY, XAU/USD,
2010-2022), validates them, serves them through the candles API and runs the backtester
on them. Also hardens the trading core found broken while integrating gold.

**Historical data**
- JForex strategy export (Dukascopy's HTTP endpoints are bot-protected; no workaround).
- `historical_candles` hypertable as integer points with a fixed scale per pair
  (`historical_price_scale`), 7.5x compressed; M5/M15/H1 (UTC) and H4/D1 (New York
  close) continuous aggregates.
- Idempotent importer (`npm run data:import`): COPY -> SQL validation (no rounding) ->
  plain INSERT with the import-log row in one transaction; skip by sha256, `--force`
  decompresses only the affected chunks; NY aggregates refreshed in one padded window.
- Real-data checks (H1/H4/D1 rebuilt from M1, year boundaries, weekly D1 shape with a
  named stub list) and spot checks against FRED noon fixings (median 0.40-1.60 pips,
  timezone/DST check) and cited gold extremes (`npm run data:validate`).

**Routing and backtests**
- `GET /api/market/candles/:pair/:tf?source=live|historical` (never mixed), shared
  reader in `libs/database`.
- Backtester reads only the history: next-bar-open fills on real bid/ask, SL/TP from the
  fill bar, pip size from `instruments`, coverage checked at submit.

**Trading core (2.6-2.7)**
- XAU/USD with a per-instrument leverage cap; spread gate fixed; mock feed from DB specs.
- Shared market clock (market hours, sessions), typed Kafka contracts, batched tick
  consumer, held exits persisted, derived open P&L with relative updates, stop-out,
  SL/TP validation and edits, MARKET-only orders.
- Integration tests in a freshly migrated `_test` database per Jest worker.

**Migrations:** Extensions; HistoricalCandles; InstrumentMetalAndMaxLeverage;
DeriveAccountOpenPnl; PositionExitsAndStopOut; HistoricalCandlesIntegerPoints.

**Verification:** full clean matrix passes (lint, typecheck, test, build, 15 projects);
507 tests including DB tests; backtests verified by hand
(`docs/validation/backtest-proof.md`). Write-up:
`docs/phase-summaries/step-2-historical-data.md`. Open questions:
`docs/OVERNIGHT-QUESTIONS.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
