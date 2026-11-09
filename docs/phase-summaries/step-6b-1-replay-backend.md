# Roadmap step 6b-1: bar replay backend

**Outcome:** a user can replay the 2010-2022 history like TradingView's bar replay, on the server: pick a pair and a
start time, then play it forward bar by bar (or step) and paper-trade against it. The server owns the clock and
never sends anything after it. Trades go through the **same code as the verified backtester**, now a shared library,
and replaying the verified backtest trades through the running service reproduces them **to the cent**:
EUR/USD 257 of 257 trades, XAU/USD 217 of 217, USD/JPY 215 of 215, every trade, total and final balance (MA crossover 10/30, H1, 2022). The frontend is step 6b-2.

Branch `step-6b-1-replay-backend` (2026-11-09/10), 5 feature commits plus this close-out, not merged.

## 1. What was built

| Commit | Group | What |
|---|---|---|
| `ee67d0c` | A | `@forexedge/trading-sim`: the backtester's fills, SL/TP, money and mark to market as pure functions; the backtester uses it (no behaviour change: backtest:verify identical before and after) |
| `5311a28` | B | replay-service (3008), migration `ReplayTables`, role `forexedge_replay_writer` + login `forexedge_replay`, session REST |
| `42288f5` | C | Server clock, playback (play/pause/step/speed/timeframe), the `/replay` socket, no-future-data reads |
| `b4ea2df` | D | Market orders with SL/TP, manual close, cancel, margin (the live formula via `@forexedge/common/money`) |
| `e6f9528` | E | Static guarantees, socket-level no-future and lifecycle suites, `replay:verify` and `replay:e2e`, a playback perf fix |
| close-out | | Migration walks updated, cleanup tool, CLAUDE.md, this write-up, validation reruns |

### The backtester's fill convention (group A, unchanged)
A signal is known only after its bar closes, so it fills at the **next existing bar's open**: BUY at the ask open,
SELL at the bid open; a long closes at the bid open, a short at the ask open; closes before opens. SL/TP are checked
on every bar from the fill bar on (a long on the bid, a short on the ask): a bar opening beyond a level fills at the
open (gap), a level touched inside the bar fills at the level, SL wins when both are inside one bar. A trade still
open at the end closes at the last bar's close. Commission 0.7 pip per side. **Replay uses the same rules per M1
minute**: an order placed at clock *t* is PENDING and fills at the open of the next traded minute after *t*.
On H1 that is the same price as the backtester's (an H1 open is its first minute's open), which is why the
equivalence holds.

### Margin and stop-out (group D)
The backtester has **no margin and no stop-out**. As decided: margin reuses the live order-service's
`marginRequiredUsd` (not a copy, through the new `@forexedge/common/money` alias), leverage 1:100 capped by
`instruments.max_leverage` (gold 1:20), at the side's clock-close quote, against free margin = equity − margin of
OPEN + PENDING. No stop-out or margin call in replay (as in the backtester).

## 2. Core concepts

- **Server-owned clock.** `replay_sessions.clock_time` is the last processed M1 minute. A client never computes
  time; it receives bars the server has already processed and saved.
- **Rebuilt current bar.** The aggregate row of a bucket that hasn't finished holds the minutes after the clock
  (the rest of the hour/day). Replay rebuilds the current bar from M1 rows with `time <= clock` and reads aggregate
  rows only for buckets before the current one.
- **Same buckets as the aggregates.** `historicalBucketSql` writes each timeframe's bucket exactly as the continuous
  aggregates do (UTC 5m→15m→1h, New York 4h→1d with the 17:00 NY origin), so a rebuilt bar lines up with its row;
  a DB test rebuilds every 5m-1d row of a real day from M1 and compares them.
- **Next-open fills, PENDING orders.** An order decided at a minute's close can't fill at a price that existed
  before the decision, or at one the user hasn't seen yet. It waits for the next processed minute.
- **One bar per step, minute by minute.** On H1 a step runs that hour's minutes in order through the engine (closes
  at the open, then pending orders at the open, then SL/TP), saves positions, balance and clock in one transaction,
  and only then emits the bar and the account.
- **Differential equivalence.** The backtester was verified against an independent SQL reproduction (step 3); replay
  is verified against the backtester's verified trades: same trades, same cents.
- **Chunk exclusion.** TimescaleDB skips hypertable chunks only for time bounds it knows when the query starts
  (parameters, constants). A bound joined from another row hides the range, and every chunk is scanned.

## 3. Architectural decisions

| Decision | Alternatives | Why |
|---|---|---|
| Move the rules into a pure lib used by both | Copy them into replay; call the backtester | One implementation of fills and money; the lib can't drift from the verified backtester, and it has no I/O to mock |
| Orders PENDING until the next processed minute (user decision) | Fill immediately by advancing the clock a minute | The backtester's convention exactly; no fill uses an unseen price; same behaviour PLAYING or PAUSED |
| Rebuild the current bar from M1 up to the clock | Send the aggregate row | The aggregate row of an unfinished bucket is future data |
| Bucket SQL shared from `@forexedge/database` | Compute buckets in TypeScript | DST and the NY origin stay in one place (Postgres), identical to the aggregates |
| Own DB login (SELECT history/instruments, write only `replay_*`) | The main DB user | The database itself refuses a write to `historical_*`, `ticks`, `candles_*` or `instruments` |
| Partial unique index for one active session | Check-then-insert | Race-free; three concurrent creates give exactly one session (tested) |
| Per-session serial lock + token-guarded chained timer | Row locks only; `setInterval` | Steps, orders and commands never interleave; a stale timer can't double the pace; slow steps never overlap |
| Pause on the last socket leaving, on every connect, on boot | Keep playing headless | Nobody watches a replay that keeps going; a reconnect never surprises the user with bars it missed |
| Reuse `marginRequiredUsd` via `@forexedge/common/money` (user decision) | Copy it into the lib | One margin formula for live and replay; the barrel would pull NestJS into the pure lib |
| Verify through the running service (`replay:verify`) | In-process engine only | Proves the deployed path: REST, socket, lock, transactions, SQL, the replay login |

## 4. Database changes

Migration `apps/auth-service/src/migrations/1792500000000-ReplayTables.ts`:
- `replay_sessions`: `user_id` (FK), `pair` (4 pairs), `start_time`, `clock_time`, `status`
  (PLAYING/PAUSED/ENDED), `speed_ms` (500/1000/2000), `timeframe` (1m-1d), `starting_balance` (100-10,000,000, default
  10,000), `balance`, timestamps, `ended_at` (set exactly when ENDED). **`replay_sessions_one_active_per_user`**:
  unique `(user_id) WHERE status <> 'ENDED'`.
- `replay_positions`: `side`, `lots`, `units`, `status` (PENDING/OPEN/CLOSED/CANCELLED), `placed_at` (the clock),
  SL/TP and entry/exit in integer points, `margin_usd`, `exit_requested_at`, `exit_reason` (SL/TP/MANUAL/SESSION_END),
  `realized_pnl_usd` (net), `cancelled_at`; a CHECK keeps each status's columns consistent.
- Role `forexedge_replay_writer` (NOLOGIN): SELECT, INSERT, UPDATE on both tables (no DELETE). Login
  `forexedge_replay` (`REPLAY_DB_USER`/`REPLAY_DB_PASS`) = it + `forexedge_readonly`, created by
  `tools/ops/create-replay-db-user.ts` (9 allowed and 16 denied statements checked).
- `down()` drops the tables and keeps the cluster-wide role; checked by `migration:revert`/`run` on the dev DB and
  in the importer's migration walk.
- No change to `historical_*`, `ticks` or `candles_*`.

## 5. Errors hit, root cause, fix

| Error | Root cause | Fix |
|---|---|---|
| Services: `ECONNRESET` / timeout to the DB and Kafka | Docker Desktop's IPv6 forward (`[::1]:15432`, `:9092`) reset connections; Node 24 tries `localhost` as IPv6 first | Environment, not code: ran with `NODE_OPTIONS=--dns-result-order=ipv4first`; no repo change (see Noticed) |
| Login tool: `cannot update view "historical_coverage"` | One denied-check targeted a view: Postgres refuses before checking privileges | Checks `historical_price_scale` and `historical_import_log` (tables) |
| `replay:verify`: HTTP 400 "Username cannot exceed 20 characters" | `replayverify_` + 8 hex = 21 | Username `rverify_*` (the email keeps `replayverify_*`) |
| A replay step took ~1.5 s (equivalence ran at ~1 bar/s) | The next-bar and current-bar queries took a time bound from a joined CTE row, so TimescaleDB couldn't exclude chunks: each step scanned all ~4.85M minutes of the pair (1,190 ms) | Bounds computed in code and passed as parameters: 158 chunks excluded at startup, 11 ms with a generic plan; bars identical (DB tests) |
| DB suites: 1 failure in market-data-import, 2 in domain-service | Their migration walks assumed `CalendarThirdPartyEvents` was the newest; `ReplayTables` now is | Both walks revert `ReplayTables` first (the importer walk also checks its `down()`) |
| No-future suite: "expected > 1000 times checked, got 183" | A guessed threshold in the test | Principled bound: more market times checked than events |
| No-future suite: a state with 0 history bars | Real: the fixture day is a Monday, so no completed D1 bar precedes it | Asserts exactly min(500, rows before the current bucket) |
| Write-scan regex missed `CALL refresh_continuous_aggregate('candles_5m'…)`; comments matched as writes | Pattern required whitespace after the quote; case-insensitive "update: never" | Separate branch for the CALL form; the positive scan matches upper-case SQL only |
| Test parse `NaN` | A regex captured the trailing quote | Capture groups |

## 6. Verification results

**Group A, no behaviour change.** `npm run backtest:verify -- --pairs EUR_USD,XAU_USD,USD_JPY` on unmodified
main and again on the refactored backtester: EUR/USD 257 / 257, XAU/USD 217 / 217, USD/JPY 215 / 215 trades, all
MATCH, net -272.20 / -555.92 / 1,485.75 USD. Both 739-line reports are identical apart from the run ids, the
timestamp and the throwaway user: every trade's times, points, reason, pips and cents, and every metric.

**Equivalence** (`npm run replay:verify`, `docs/validation/replay-equivalence.md`), on the verified report just
regenerated by `backtest:verify` (257/217/215, all MATCH):

| Pair | H1 steps | Time | Trades (verified / replayed) | Net USD | Final balance | Result |
|---|---|---|---|---|---|---|
| EUR/USD | 6,240 | 179 s | 257 / 257 | -272.20 / -272.20 | 9,727.80 | match |
| XAU/USD | 5,915 | 185 s | 217 / 217 | -555.92 / -555.92 | 9,444.08 | match |
| USD/JPY | 6,240 | 170 s | 215 / 215 | 1,485.75 / 1,485.75 | 11,485.75 | match |

The final balances equal the backtester's final equity. The first EUR/USD run (before the perf fix) also matched,
257 / 257.

**End to end** (`npm run replay:e2e`, `docs/validation/replay-backend-e2e.md`, all 18 checks pass), EUR/USD from
2022-03-01 09:30 UTC:
- Created PAUSED, balance 10,000.00; a second create is 409 with the active id; the socket state has 500 history
  bars and a current bar ending at the clock (bid/ask 1.12186/1.12188).
- Play, 4 bars at each speed: mean gaps 2,005 ms (2,000), 1,013 ms (1,000), 511 ms (500). 750, "1000" and 0.5
  refused.
- BUY 0.1 lot at 09:42 (bid 1.12032), SL 1.11932, TP 1.12132: PENDING, margin $112.04; filled at 09:43 at the ask
  open 1.12035; closed by SL at 09:49 at 1.11932 (played on 5m at 500 ms); realized -$11.70 =
  (111932 - 112035 - 14) x 10,000 / 10^5; balance 9,988.30.
- Disconnect while playing: PAUSED at 09:59, clock unchanged 2 s later; reconnect: PAUSED, 0 bars in 2 s.
- End: ENDED, balance 9,988.30, the socket got `ended`; no active session afterwards.

**Real minute where SL and TP both hit** (lifecycle suite): EUR/USD 2022-01-03 13:43 UTC. A long placed at 13:41
(bid close 1.13495) with SL 1.13478 / TP 1.13539 fills at 13:42 (bid 1.13479-1.13498, neither level); 13:43 opens
at 1.13480 and reaches both: closed SL at 1.13478.

**Guarantee proofs on planted faults:** a real `import 'kafkajs'` in replay-service and `@nestjs/common` in
trading-sim fail the dependency test (2 failures, both named), restored to green; one extra aggregate row in the
history read (the current bucket's completed row) fails the no-future suite (17 bars sent, 16 completed).

**Clean matrix** (`nx reset`, `dist/` deleted, `npx nx run-many -t lint typecheck test build --parallel=2`):
**all 21 projects pass** (472 s; 18 before plus replay-service, trading-sim, replay-verify). ESLint 0 errors, no
warning on a line this step wrote. Jest 793 passed (684 at 6a + trading-sim 34 + replay-service 84 + replay-verify 6
- the 15 money tests moved out of ws-gateway), 88 skipped (DB suites). pytest unchanged: research-agent 150 passed /
80 skipped, ml-service 47 / 30.

**Opt-in DB suites** (`RUN_DB_TESTS=true`, `--skip-nx-cache`): replay-service 134/134 (50 DB and socket tests),
order-service 216/216, market-data-import 67/67 (incl. the live-isolation fingerprint and the importer's
migration walk, now reverting `ReplayTables` too), domain-service 67/67. The first run failed 1 + 2 tests: their
migration walks assumed `CalendarThirdPartyEvents` was the newest migration (§5).

**Validation reruns:** `npm run data:validate` all checks pass (only the date line changed); `backtest:verify`
257 / 217 / 215, all MATCH.

**Test counts by project:** trading-sim 34 (new); replay-service 134 (84 default + 50 DB); replay-verify 6 (new);
ws-gateway 83 (98 - 15 moved to trading-sim).

**Close-out:** 12 throwaway users deleted with `tools/ops/delete-verification-users.ts` (14 backtest runs and
their 14 results objects, 11 replay sessions, 978 replay positions; 0 orders, positions or accounts), and their
stale BullMQ jobs with `clear-stale-backtest-jobs.ts`. The run and session ids in the validation reports belong to
them; re-run the tools to reproduce. Services stopped.

## 7. Commands cheatsheet

```sh
# Migration and the replay login (REPLAY_DB_USER / REPLAY_DB_PASS in .env)
npm run migration:run
npx ts-node --transpile-only tools/ops/create-replay-db-user.ts

# Run (compiled mode)
npx nx build replay-service && node dist/apps/replay-service/main.js      # :3008, /api/replay, socket /replay

# Tests
npx nx test replay-service                                               # default suite (no DB)
RUN_DB_TESTS=true npx nx test replay-service --skip-nx-cache             # + DB and socket suites
npx nx test trading-sim

# Equivalence and end to end (auth-service + replay-service running)
npm run backtest:verify -- --pairs EUR_USD,XAU_USD,USD_JPY              # (ws-gateway too) refreshes the verified report
npm run replay:verify -- [--pairs EUR_USD,XAU_USD,USD_JPY]
npm run replay:e2e

# Throwaway verification users (dry run, then apply), then their stale jobs
npx ts-node --transpile-only tools/ops/delete-verification-users.ts [--apply]
npx ts-node --transpile-only tools/ops/clear-stale-backtest-jobs.ts [--apply]
```

REST (JWT): `POST /api/replay/sessions` `{instrument, startTime: 'YYYY-MM-DDTHH:MMZ', timeframe, startingBalance?}`,
`GET /api/replay/sessions/active`, `POST /api/replay/sessions/active/end`, `POST /api/replay/sessions/active/orders`
`{side, lots, stopLoss?, takeProfit?}`, `POST .../orders/:id/cancel`, `POST .../positions/:id/close`.
Socket `/replay` (`auth: { token }`): `play`, `pause`, `step`, `setSpeed {speedMs}`, `setTimeframe {timeframe}` →
ack `{ok, result | error}`; events `state`, `bar`, `account`, `positions`, `status`, `endOfData`, `ended`.

## 8. Interview Q&A

**How do you guarantee replay never shows the future?**
The server owns the clock: the last M1 minute it processed and saved. Every read is bounded by it. The current bar
is rebuilt from minutes up to the clock, because the stored aggregate for an unfinished hour already contains the
rest of the hour. History is only aggregate rows that end before the current bar. Every outgoing payload then passes
a guard that throws if any market time is after the clock. A socket-level test drives a real session across H4 and
D1 boundaries, a disconnect and a reconnect, and checks every received event independently; a planted leak (one
extra aggregate row) makes it fail.

**Why don't market orders fill immediately?**
An order is decided at a minute's close. The first price it could get is the next minute's open, which the user
hasn't seen yet. Filling at the close would trade at a price already gone; filling immediately at the next open
would leak it. So the order is PENDING and fills when the clock processes that minute, exactly the backtester's
"signal at the close, fill at the next open".

**How do you know replay trades like the backtester?**
Both call the same library, and I proved it end to end: the backtester's trades, verified against an independent SQL
reproduction, are replayed through the running replay-service. A session per pair steps through 2022 on H1; at each
signal bar's close the tool sends the same close/order. Every trade's fill bar, fill points, exit and net cents, and
the total, match (689 trades over 18,395 H1 steps: EUR/USD 257, XAU/USD 217, USD/JPY 215, net -272.20 / -555.92 / +1,485.75 USD).

**Why did replay steps take 1.5 seconds, and how did you find it?**
The equivalence run was far slower than the unit tests suggested, so I profiled the step query with
`EXPLAIN ANALYZE`: 4.85M rows scanned for a 60-minute bar. The query took its lower time bound from a joined CTE
row, which TimescaleDB can't use to exclude chunks at startup. Passing both bounds as parameters let it exclude 158
chunks: 11 ms even with a generic plan.

**Why a partial unique index instead of checking for an active session?**
A check-then-insert has a race: two tabs can both see "no session" and both insert. A unique index on
`(user_id) WHERE status <> 'ENDED'` lets the database reject the second; the service turns that into a 409 with the
existing session's id. The test fires three creates at once and gets exactly one session.

**What keeps two timers from running one session?**
Each session has one chained `setTimeout` and a token. Pause or play bumps the token; a timer that fires with an old
token does nothing. All steps, orders and commands for a session run through a per-session serial lock, so they read
what the previous one saved.

**Why a separate database login?**
Least privilege: replay can read the history and instruments and write only its two tables. Even a bug can't write
`historical_*`, `ticks` or the live candles: the database refuses (checked by the login tool and the DB tests).

## 9. Noticed, not done

- **Stop-out for replay**: none (the backtester has none either); equity can go below the margin in use.
- **Single instance only**: timers and the session lock are in-process; more instances need a DB-level lock and timer
  ownership (step 7).
- **Docker Desktop IPv6 forwarding** reset `localhost` connections to Postgres and Kafka this session; worked around
  per process (`NODE_OPTIONS=--dns-result-order=ipv4first`). If it persists after the Docker restart, document
  `DB_HOST=127.0.0.1` in CLAUDE.md (owner's call).
- **Access-token expiry on an open socket** isn't enforced (same as ws-gateway); a reconnect needs a fresh token.
- **A second tab pauses playback** when it connects (by design: a connecting socket always gets PAUSED); 6b-2 should
  say so.
- **SL/TP resolution differs from the backtester by design**: replay checks every minute, the backtester checks
  bars of its timeframe, so SL/TP strategies (London breakout) can legitimately differ. `replay:verify` replays MA
  crossover (signal exits) only; no verified SL/TP run exists yet.
- **Closed-trade history**: the state carries pending/open positions and the last 50 closed; a paginated trades
  endpoint is for 6b-2. Ended sessions are kept with no retention policy.
- **No health endpoint** on replay-service (as market/domain-service; step 7 item).
- Commission is a fixed 0.7 pip per side and spreads are the historical bid/ask (inherited from the backtester).

## 10. PR text

````md
## Step 6b-1: bar replay backend

A TradingView-style bar replay over the 2010–2022 history, server-side: the server owns the clock and never sends a
future bar. Frontend is 6b-2.

### What's in it
- **`@forexedge/trading-sim`** — the backtester's fills, SL/TP, money and mark to market as pure functions (no I/O,
  NestJS, TypeORM or Kafka). The backtester uses it; `backtest:verify` is identical before and after
  (257 / 217 / 215 trades, every trade and metric).
- **replay-service (:3008)** — sessions (one active per user, 409 with its id), a server clock that steps one
  displayed bar at a time through the M1 minutes, Socket.IO `/replay` (play/pause/step, 0.5/1/2 s per bar, 1m–1d),
  market orders with SL/TP, manual close, cancel, margin (the live formula), equity at the clock close.
- **Data** — migration `ReplayTables` (partial unique index, per-state CHECKs) and the `forexedge_replay` login
  (history + instruments read-only, writes `replay_*` only).
- **Guarantees** — no Kafka in replay (static, transitive), no writes to `historical_*`/`ticks`/`candles_*`,
  no-future-data across play/step/timeframe/reconnect and H4/D1 boundaries, lifecycle (disconnect/boot → PAUSED,
  reconnect never plays), SL first on a real minute where SL and TP both hit.
- **Equivalence** — `npm run replay:verify` replays the verified backtest trades through the running service:
  EUR/USD 257/257 (-272.20), XAU/USD 217/217 (-555.92), USD/JPY 215/215 (+1,485.75): every trade, the totals and the final balances match to the cent.

### Checks
- Clean matrix: all 21 projects pass lint, typecheck, test, build (Jest 793, pytest 150 + 47)
- DB suites: replay-service 134/134, order-service 216/216, market-data-import 67/67, domain-service 67/67
- `data:validate` all pass; `backtest:verify` 257/217/215 MATCH; `replay:verify` 257/217/215 MATCH
- `replay:e2e`: create, play at 2/1/0.5 s, order with SL/TP closed by SL (-$11.70, recomputed), disconnect → PAUSED,
  reconnect PAUSED and silent, end

### Not in this PR
Frontend (6b-2), stop-out, multi-instance replay, a closed-trades endpoint. See §9 of
`docs/phase-summaries/step-6b-1-replay-backend.md`.
````
