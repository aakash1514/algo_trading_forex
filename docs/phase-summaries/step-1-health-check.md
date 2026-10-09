# Step 1: Health check

**Date:** 2026-10-09
**Scope:** Roadmap step 1: bring infra up, make every project build, lint, typecheck, test and run, and fix what was broken.
**Starting point:** Phases 1–6 were built by June 2026 and had not been run since.
**Outcome:** All 9 projects (5 services, frontend, 3 libs) pass build, lint (0 errors), typecheck and tests from a clean `dist/`. All 5 services start from the repo root. Paper trading works end to end in a real browser: orders, live positions and account, and sessions that survive reloads and token expiry.

## Results

| Check | Before | After |
|---|---|---|
| Builds | 5/6 apps (frontend failed); service builds only passed if typecheck had run first | 9/9 from an empty `dist/` |
| Lint errors | 29,744 (frontend linted `.next/`), 3 libs failing | 0 |
| Typecheck | `nx typecheck` failed for every service | 9/9, plus the 5 e2e projects |
| Tests | 50 (4 stale scaffold specs failing, frontend tests not runnable) | 162 passing |
| Paper market order from the UI | Impossible (silently blocked, 500, or rejected) | Works; margin and P&L hand-verified |
| Reload while logged in | Logged out | Session restored from cookie |
| Access-token expiry | Infinite 401 → refresh → 401 loop | One refresh, request retried |

Tests by project: order-service 37 → 96, domain-service 9 → 19, frontend 0 runnable → 25, common 0 → 16. ws-gateway has none yet (step 3).

## Errors, root causes and fixes

### Tooling and build

| Symptom | Root cause | Fix |
|---|---|---|
| `nx typecheck` failed everywhere (sync gate, TS5069, TS6306, TS6304, TS6307) | The `@nx/js/typescript` plugin runs `tsc --build`, which needs TS project references. The tsconfigs only had `paths` aliases. | `nx sync`; libs `composite` + `declaration`; spec configs reference `tsconfig.lib.json`; per-project `outDir` so `.tsbuildinfo` files stop colliding |
| e2e projects failed `run-many -t typecheck` (TS5069) | Same declaration issue in the 5 e2e tsconfigs, missed by per-project checks | `declaration: true` + per-project `outDir` |
| Service builds failed from a clean `dist/` (TS6305) | With references, webpack's in-build type checker resolves libs to `.d.ts` files that only `nx typecheck` produces | `typeCheckOptions: false` (transpile-only, as in Nx's TS solution setup); types are enforced by `nx typecheck` |
| Frontend `next build` failed while prerendering (`null.useMemo`) | `NODE_ENV=development` in `.env`, which Nx loads into every task | Removed it; TypeORM logging moved to `DB_LOGGING` |
| 29,744 frontend lint errors | The Nx lint executor runs ESLint from the repo root with the project config as `overrideConfigFile`, so `ignores: ['.next/**']` resolved against the root | `'**/.next/**'`, `'**/next-env.d.ts'` |
| Frontend tests couldn't start | `next/jest` resolves `dir` against `process.cwd()` (the repo root under Nx) | `dir: __dirname` |
| 3 libs failed lint | `@nx/dependency-checks` on internal libs that are never published | Rule disabled with a comment |
| ws-gateway exited on start from the repo root | `envFilePath: '../../infra/.env'` resolves against the working directory | Uses the root `.env` like the other services; `infra/.env` removed |
| TimescaleDB logged `FATAL` every 10s | The healthcheck `pg_isready` had no `-d`, so it probed a database named after the user | `-d ${DB_NAME}` |
| Images could drift | Every image except Redis used `:latest` | Pinned to the exact running versions (tags verified against running digests). MinIO is no longer pullable at all, so a `docker save` backup was taken |

### Frontend correctness

| Symptom | Root cause | Fix |
|---|---|---|
| Chart failed to compile | Written against an older lightweight-charts API (`timeScale.textColor`, untyped `time`) | `CandlestickData<UTCTimestamp>`, safe `number \| string` price parsing |
| JPY pips and spreads off by 100× | Hardcoded `* 10000` | `lib/pip.ts`, mirroring `instruments.pip_size` |
| Live ticks added one bar per tick | Each tick used its own second as the bar time and the bid for all four OHLC values | Align to the bar start, extend high/low/close, use mid (candles are built from mid) |
| Dashboard crashed once a position existed | node-pg returns NUMERIC as strings; the UI called `.toFixed()` | `decimalTransformer` on order, position and account entities |

### Trading flow (orders, money, positions)

| Symptom | Root cause | Fix |
|---|---|---|
| Order button silently did nothing | An empty SL/TP field became `NaN` via `valueAsNumber`, failing zod with no visible error | Empty → `undefined`; SL/TP errors shown |
| UI orders → 500 | UI sent no `pair` (NOT NULL) and `BUY` instead of `LONG`; `SubmitOrderDto` was an interface, so nothing validated it | class-validator DTO; server derives `pair` from `instrument` |
| Well-formed orders rejected: "Instrument EUR_USD not found" | Gate 1 queried `pair = 'EUR_USD'`; the table holds `EUR/USD` | Look up by derived pair |
| 0.1 lot USD/JPY needed $15,023 margin | Margin was `lots × 100,000 × price ÷ leverage`, with no currency conversion and a hardcoded lot size | `units × base→USD ÷ leverage` with `lot_size`/`pip_size` from the DB; shared by order- and domain-service |
| Market orders never failed the margin check | Margin was evaluated at `requestedPrice ?? 0` | Checked at the live entry price (ask for LONG, bid for SHORT); no price → rejected |
| Account API showed stale margin/P&L (218.85 vs 476.69 in the DB) | A per-user cache, never refreshed, while other code paths wrote the table directly; the margin-call check read it too | Read the row on every call |
| Spread gate never fired; orders stamped `OFF_HOURS` | AppModule and KafkaConsumerModule each declared the same services, so there were two instances with separate state | Single instances, owned and exported by KafkaConsumerModule |
| **Any user could see and close any user's positions** | Controller read `req.user.userId` (undefined; the JWT strategy sets `id`), and TypeORM drops `undefined` filters | `req.user.id`, 404 for others' positions, controller tests |
| Closing a position destroyed the entry price | Close wrote the exit price into `orders.executed_price` | Exit price lives on the position only |
| Manual close used a stale price | Used the last stored mid | Live bid (LONG) or ask (SHORT) |
| Lifecycle events could precede the commit | Published inside the transaction callback | Published after the transaction resolves |
| Per-pair lot limit ignored open positions | Checked only the new order's size | Counts gross open lots on the pair |
| Daily-loss window depended on server timezone | `setHours(0)` | `setUTCHours(0)` |
| No live positions/account in the UI | Nothing published `positions.updated`; socket handlers only patched state | `RealtimePublisher` (throttled ~1/s, after commit) + `accounts.updated`; hook wires `setPositions`/`setAccountSummary` |

### Auth

| Symptom | Root cause | Fix |
|---|---|---|
| Reload logged the user out | Nothing restored `isAuthenticated`; the old rehydrator read keys nothing wrote | Restore from the httpOnly refresh cookie on load; `AuthGuard` waits for it |
| Infinite 401 loop after token expiry | The interceptor saved the new token to localStorage but retried with the stale store token | Store the token before retrying |
| Concurrent refreshes could log the user out | Refresh tokens rotate, so a second concurrent refresh is rejected | Single-flight `refreshSession()` shared by the restore and all 401s |
| Sign out didn't stick | Never called `/auth/logout`, and the server cleared the cookie on the wrong path | Call logout; `clearCookie(..., { path: '/api/auth' })` |
| Token readable by XSS | Access token persisted in localStorage | In memory only; legacy keys removed on load |

## Key decisions

- **Transpile-only builds, types in `nx typecheck`.** Same split as Nx's TS solution setup. `ts-loader` was already `transpileOnly`, so the emitted JavaScript didn't change. Trade-off: `nx build` alone no longer catches type errors, so typecheck must run before committing (documented as a gotcha).
- **The server derives `pair`; clients send only `instrument`.** Two fields that must agree eventually won't. Validating one input with class-validator also turns a late 500 into an early 400.
- **Money math is shared and DB-driven.** One set of pure functions (`libs/common/src/lib/money.ts`) serves both services. Specs come from `instruments`, so XAU/USD (100 oz) needs only a row. Using `base→USD = price × quote→USD` means only a quote→USD rate is ever needed.
- **P&L converts at the current rate,** not with the pip value frozen at open. That makes it exact for USD-base and cross pairs.
- **Decimals are converted once, at the entity.** Every consumer gets numbers. Prices (6 dp) and money (2 dp) are well within a double's precision.
- **No cache for mutable account state.** Four code paths write `account_summary`; a cache that only one of them updates is a correctness bug. Instruments are static reference data, so caching those is fine.
- **Real-time events: one publisher, after commit, throttled with a trailing edge.** At most one message per second per position or account, and the latest value always arrives.
- **Auth: access token in memory, refresh token in an httpOnly cookie, single-flight refresh.** Rotation makes concurrent refreshes destructive, so they must share one call.
- **Paper accounts were reset rather than recalculated.** Realized balances had been valued with the old formulas, and the conversion rates at fill time were never stored, so history couldn't be faithfully recalculated. A `pg_dump` of orders, positions and accounts was taken first.
- **Images pinned to the exact running versions,** with tags verified against the running digests.

## Commands used

```sh
# Infra
docker compose -f infra/docker-compose.yml --env-file .env up -d
docker exec forexedge_tsdb psql -U "$DB_USER" -d "$DB_NAME" -c "..."
MSYS_NO_PATHCONV=1 docker exec forexedge_kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
docker buildx imagetools inspect <tag>        # verify pinned tags match running digests
docker save -o ~/docker-backups/minio-RELEASE.2025-09-07T16-13-09Z.tar minio/minio:RELEASE.2025-09-07T16-13-09Z

# Workspace
npx nx sync / npx nx sync:check
npx nx reset && rm -rf dist                   # clean-state verification
npx nx run-many -t build lint typecheck test --parallel=2 --skip-nx-cache
npx tsc --noEmit -p apps/frontend/tsconfig.json   # frontend has no typecheck target

# Runtime
node dist/apps/<svc>/main.js                  # from the repo root
JWT_ACCESS_EXPIRES=20s node dist/apps/auth-service/main.js   # expiry testing (env override, no file change)
npx nx serve frontend --configuration=production
```

Browser checks were driven with a small Chrome DevTools Protocol script (headless Chrome, no extra dependencies): real form input, network and socket-frame capture, and screenshots.

## Still open (scheduled)

- **Step 2:** purge June mock data from the candle aggregates before importing; add the XAU/USD instruments row and frontend lists.
- **Step 3:** ws-gateway backtest tests; clear stale BullMQ jobs.
- **Step 7:** env-driven cross-origin refresh cookie; replace MinIO; seed order-service session state on startup; health endpoints for every service.
- **Ongoing:** `npm audit` (88 issues, no `--force`); lint warnings (0 errors).

## Interview Q&A

**Q: 37 order-service tests passed, yet no market order could succeed. How?**
The tests mocked repositories and used a third pair format, `EURUSD`. The DB holds `EUR/USD` and Redis uses `price:EUR_USD`, so the broken lookup was never exercised, and DTOs were built with fields the UI never sent. Now tests assert the exact query keys, run request bodies through the real `ValidationPipe` options, and use hand-calculated money values.

**Q: Why did `NODE_ENV=development` in `.env` break a production Next.js build?**
Nx loads the root `.env` into every task. Next.js then prerendered with React's development build inside a production build, which surfaced as `null.useMemo` during static generation. Dedicated flags such as `DB_LOGGING` avoid overloading `NODE_ENV`.

**Q: Explain the margin formula and why the old one was wrong for USD/JPY.**
Margin is notional in the account currency divided by leverage: `units × base→USD ÷ leverage`. The old code multiplied by the pair's price, which is the quote currency per base unit. For USD/JPY that's JPY, so it overstated margin by about 150×. Using `base→USD = price × quote→USD` works for every pair: quote→USD is 1 for USD-quote pairs, 1/price for USD-base pairs, and a live rate for crosses.

**Q: How do you stop concurrent 401s from logging the user out?**
Refresh tokens rotate, so the first refresh invalidates the cookie the second one sends. All callers await a single module-level promise (single-flight). The interceptor stores the new token before retrying, and never refreshes on auth endpoints.

**Q: Why throttle position updates with a trailing edge rather than simply dropping events?**
Dropping can lose the final value: the last tick before the market goes quiet. A trailing throttle sends at most one message per window and always delivers the latest state at the end of the window.

**Q: How did one wrong property name become a data leak?**
`req.user.userId` was undefined because the JWT strategy sets `req.user.id`. TypeORM treats `undefined` in a `where` object as "no condition", so `find({ where: { userId: undefined, isOpen: true } })` returned every user's positions. Fix: the correct property, plus controller tests that pin the user scoping.

**Q: Why disable webpack's type checker? Isn't that less safe?**
With project references, the in-build checker needs lib `.d.ts` outputs that only `tsc --build` produces, so clean builds failed. Running type checking once in `nx typecheck` (`tsc --build`) is stricter and incremental. The trade-off is discipline: run typecheck before committing.

**Q: Why reset the paper accounts instead of migrating them?**
Correct historical P&L needs the cross rates at each fill, which were never stored. Recalculating would have meant inventing data. Resetting test accounts, with a backup taken first, was honest and simple.
