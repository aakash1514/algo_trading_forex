# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ForexEdge is a forex trading platform built as an Nx monorepo (npm workspaces). It has five NestJS microservices that talk over Kafka, a Next.js 16 frontend, and three shared libraries. Trading is paper-only for now: order-service binds `BROKER_ADAPTER` to `PaperBrokerAdapter`.

## Commands

Run every command from the repo root. Each Nx target has the form `npx nx <target> <project>`.

```sh
# Infra: TimescaleDB (host port 15432), Redis, Kafka (KRaft), MinIO, Prometheus, Grafana
docker compose -f infra/docker-compose.yml --env-file .env up -d

# Run a service (serve builds with webpack first, then runs the dist output)
npx nx serve auth-service        # also: market-service, domain-service, order-service, ws-gateway
npx nx dev frontend              # Next.js dev server

npx nx build <project>
npx nx lint <project>
npx nx typecheck <project>
npx nx test <project>                                  # Jest (inferred target)
npx nx test order-service --testFile=order.service.spec.ts   # single test file
npx nx test order-service -t "rejects when margin"           # filter by test name
npx nx e2e <project>-e2e                               # builds and serves the app first
npx nx run-many -t test                                # all projects

# DB migrations (TypeORM, root data-source.ts, reads root .env)
npm run migration:generate -- apps/auth-service/src/migrations/<Name>
npm run migration:run
npm run migration:revert
npm run seed:instruments
```

## Architecture

### Services and ports
All backend services use the global prefix `/api`. Every service's CORS allowlist is `localhost:4200` and `localhost:3001`.

| Service | Port | Responsibility |
|---|---|---|
| auth-service | 3000 | Register/login and JWT access + refresh tokens (refresh token in a cookie). Argon2 password hashing. **Owns all DB migrations and seeds** for the whole system. |
| market-service | 3002 | Tick stream ingestion (`StreamModule` picks `MockStreamProvider` or `OandaStreamProvider` based on `USE_MOCK_DATA`, default `true`). Publishes `forex.ticks`. Consumes its own ticks to write them to TimescaleDB and Redis. Serves candle and instrument queries. |
| domain-service | 3003 | Forex domain logic: pip calc, margin, swaps, session clock, spread monitor, economic calendar. Scheduled jobs publish `forex.sessions`, `forex.spread-alerts`, `forex.calendar-events`. |
| order-service | 3004 | Orders, positions, account. Validates orders using live ticks, spread alerts, and session state from Kafka. Publishes `orders.lifecycle`. |
| ws-gateway | 3005 | Socket.IO gateway (rooms `user:<id>`, events `tick:<instrument>`). Relays `forex.ticks`, `orders.lifecycle`, `positions.updated`, `accounts.updated` to clients. Also hosts the **backtest engine**: a BullMQ queue/worker with strategies in `backtest/strategies/` registered via `strategy.registry.ts`, results stored in MinIO, and Bull Board at `/admin/queues` (HTTP Basic auth from `BULL_BOARD_USER`/`BULL_BOARD_PASS`; not mounted unless both are set). |

order-service's `RealtimePublisher` publishes `positions.updated` (tick-driven P&L throttled to ~1/s per position, plus a full snapshot after a fill/close) and `accounts.updated`, always after the DB commit. Socket event names live in `libs/kafka/src/lib/interfaces/realtime.interface.ts`; the frontend mirrors `SOCKET_EVENTS` in `src/lib/constants.ts`.

Every Kafka topic has one message type and a validating `parse*` function in `libs/kafka/src/lib/contracts/topics.ts` (with the producer/consumer map in its header). Producers type their payloads with it; consumers parse with it, never `JSON.parse(...) as T` (two consumers once read fields no producer sent). Contract tests parse real captured messages (`contracts/fixtures/`).

### Kafka flow
```
market-service ─forex.ticks─▶ market-service (DB/cache writers), domain-service (spread monitor), order-service, ws-gateway
domain-service ─forex.sessions / forex.spread-alerts─▶ (no consumer; order-service computes sessions from the shared clock)
domain-service ─forex.calendar-events─▶ NOT BUILT: no consumer, and the producer has never fired (the calendar page uses REST)
order-service  ─orders.lifecycle / positions.updated / accounts.updated─▶ ws-gateway ─socket.io─▶ frontend
```
Most services use `@forexedge/kafka`. `KafkaModule` is `@Global`. `KafkaConsumerService.subscribe(groupId, topics, handler)` hands the handler the message value as a string, and `KafkaProducerService.publish(topic, key, value)` JSON-serializes. order-service's consumers in `apps/order-service/src/kafka/` use raw kafkajs consumers instead. `createKafkaClient` is a process-wide singleton.

### Shared libraries (path aliases in `tsconfig.base.json`)
- `@forexedge/database`: every TypeORM entity. Each service lists only the entities it needs in its own `TypeOrmModule.forRootAsync`, with `synchronize: false`. A new entity must be exported from `libs/database/src/index.ts`, added to the services that use it, and get a migration under `apps/auth-service/src/migrations/`.
- `@forexedge/kafka`: Kafka client, producer/consumer services, `KAFKA_TOPICS`, tick interface.
- `@forexedge/common`: broker interface and the `BROKER_ADAPTER` DI token.

### Per-service conventions
- Every service has its own small `redis/` module (with an injection decorator) instead of a shared lib.
- order-service and ws-gateway don't issue tokens. They validate JWTs from auth-service with their own `auth/jwt.strategy.ts` and `jwt-auth.guard.ts`, so the `JWT_ACCESS_SECRET` values must match.
- Config comes from `@nestjs/config` with `ConfigModule.forRoot({ isGlobal: true })`, which reads `.env` from the cwd, so every service (and `npm run migration:*`) runs from the repo root, which has the only `.env`. Docker Compose needs `--env-file .env` because the compose file lives in `infra/`. Postgres and Redis support TLS through env flags (e.g. `DB_SSL=true`) for managed hosting (Aiven).

### Frontend (`apps/frontend`)
- Next.js App Router with route groups `(auth)` and `(dashboard)`, Tailwind, Radix UI, and `lightweight-charts`.
- State uses Redux Toolkit. RTK Query APIs in `src/store/api/*.api.ts` all extend `baseApi`, which attaches the bearer token from the store. The access token is **in memory only** (never localStorage); on app load `SessionRestorer` restores the session from the httpOnly refresh cookie, and `AuthGuard` waits for it. On a 401, `baseApi` awaits `refreshSession()` (`src/lib/session.ts`), stores the new token, then retries.
- Backend URLs are hardcoded in `src/lib/constants.ts` (`API_BASE`, `WS_URL`). Live data comes through `hooks/useForexSocket.ts`.
- Instrument symbols use OANDA format (`EUR_USD`).


## Environment
- Windows + Docker Desktop (no WSL2). Node v24+, Nx v22.
- **Use Git Bash only.** PowerShell 5.1 crashes at startup in this environment
  (`InitialSessionState` type initializer exception), so don't use it.
- Docker Desktop doesn't auto-start; launch it before `docker compose up`.
- Use Windows-compatible commands. In Git Bash, wrap Docker commands that use paths in `bash -c "..."`,
  and set `MSYS_NO_PATHCONV=1` for `docker exec` with container paths (e.g. `/opt/kafka/bin/...`).
- Local Postgres 13/15 occupy 5432/5433, so TimescaleDB is on host port **15432**. Don't change it.
- The laptop is low on resources. For running several services, prefer compiled mode
  (`npx nx build <svc>` then `node dist/apps/<svc>/main.js`) over multiple `nx serve` watchers.

## Critical gotchas (learned the hard way, don't regress these)
- **Pair format:** DB and REST APIs use `EUR/USD` (slash). Redis keys use `price:EUR_USD` (underscore). The frontend and socket events use `EUR_USD`. Check which format a layer expects before touching it.
- Redis price value: `{ pair, instrument, bid, ask, mid, spread, timestamp, source }`.
- In order-service and ws-gateway, `req.user.id` (NOT `userId`). JwtStrategy returns `{ id: payload.sub, email, role }` and rejects tokens without `sub`.
- **Authorization:** TypeORM drops `undefined` from a `where` object, so a query scoped by a missing user id matches every row (this leaked all users' positions once). Every user-scoped service method calls `assertUserId(userId)` (`@forexedge/common`) first, and reads are scoped by owner in the query itself (`where: { id, userId }`), so another user's resource is a 404, never a 403. Idempotency keys are globally unique: another user's key is a 409.
- TypeORM: entities are direct class references (no globs) and use `!` definite assignment. Nullable union columns need explicit `type: 'varchar'`. Webpack must keep `optimization.minimize: false`, or entity class names break.
- Never store derived columns. `account_summary` stores only balance and margin_used. Open (unrealized) P&L is the sum of the open positions, and equity, free margin and margin level are computed on read (`AccountService`).
- `account_summary` writes are relative SQL updates only (`balance + :pnl`, `margin_used + :m`). Writing back a row read earlier loses concurrent updates (reproduced; covered by `account-consistency.db.spec.ts`, run with `RUN_DB_TESTS=true`). `AccountInvariantMonitor` logs any drift once a minute.
- Tick/time-series tables use raw SQL migrations, never ORM sync on hypertables.
- After a DB reset, refresh the TimescaleDB continuous aggregates bottom-up (1m → 5m → … ) with `CALL refresh_continuous_aggregate(...)`.
- Order FSM transitions are synchronous DB transactions. Kafka publish happens only after commit.
- KafkaJS needs `Partitioners.LegacyPartitioner` and `KAFKAJS_NO_PARTITIONER_WARNING=1`. Topics are ensured before the producer connects (KRaft cold start).
- ws-gateway bootstrap order: register Bull Board middleware BEFORE the Socket.io adapter. Socket.io CORS lives in the custom `SocketIoAdapter`, not `enableCors()`.
- Frontend: Tailwind **v3** (not v4). lightweight-charts v5 uses `addSeries(CandlestickSeries, opts)`. Use `createSelector` for derived Redux arrays.
- Backtest results come back as **flat fields** on the run object (no nested `metrics` key).
- Pip size: the source of truth is `instruments.pip_size` (0.01 for JPY-quoted pairs, else 0.0001).
  The frontend uses `apps/frontend/src/lib/pip.ts`, never a hardcoded `* 10000`. Candles are built from **mid**.
- Money math lives in `libs/common/src/lib/money.ts` (shared by order- and domain-service):
  margin = units × base→USD ÷ leverage, pip value = units × pip_size × quote→USD, with
  base→USD = price × quote→USD. Contract specs come from `instruments` (order-service `PricingService`);
  crosses convert via the live QUOTE/USD (or inverse USD/QUOTE) price. Never hardcode lot or pip sizes.
- Clients send `instrument` (`EUR_USD`) only; order-service derives `pair` with `instrumentToPair()`.
- Refresh tokens rotate on every use: never fire two refreshes concurrently (use `refreshSession()`).
- order-service: PositionService, AccountService, OrderValidationService, RealtimePublisher, PricingService,
  OpenPairsIndex, MarketHoursPolicy, StopOutService and AccountInvariantMonitor are provided once, by
  `KafkaConsumerModule`. Don't also list them in AppModule (duplicate instances have separate state).
- Market hours come from the shared clock `libs/common/src/lib/market-hours.ts` (FX Sun 17:00 to Fri 17:00 New York;
  metals open Sun 18:00 and pause 17:00-18:00 Mon-Thu). Orders and manual closes are rejected while closed; SL/TP
  changes and cancels are allowed. order-service's tick consumer ignores ticks stamped while closed. Dev-only flags,
  both strictly `true`/`false`: `MARKET_HOURS_GATE=false` (order-service) and `MOCK_STREAM_WHEN_CLOSED=true`
  (market-service), used together to trade on weekends. Sessions on orders come from the same clock.
- Redis `price:<INSTRUMENT>` expires 2 s after the last tick, so nothing fills on a stale price.
  `price:last:<INSTRUMENT>` has no expiry and is only a reference (validating SL/TP while the market is closed).
- A triggered stop-loss/take-profit is committed on the position (`pending_exit_*`) before it is booked and is retried
  from the DB, so a restart can't lose it. It books at the triggering tick's price, never the SL/TP level.
- Stop-out (margin level < 50%) closes the biggest loser first until the level is back above 50%; close_reason
  `STOP_OUT`. `MARGIN_CALL` is a log warning only and is never written to open positions.
- Only MARKET orders are executed; LIMIT/STOP/... are rejected (no pending-order engine yet). SL/TP must sit on the
  right side of the exit price (LONG: SL < bid < TP; SHORT: TP < ask < SL), at placement and on PATCH.

### Tooling gotchas
- **Never put `NODE_ENV` in `.env`.** Nx loads the root `.env` into every task, and
  `NODE_ENV=development` makes `next build` fail while prerendering (`Cannot read properties of null
  (reading 'useMemo')`). Use dedicated flags instead (e.g. `DB_LOGGING=true` for TypeORM SQL logging).
- **Nx lint runs ESLint from the repo root** with the project's config as `overrideConfigFile`, so
  ignore patterns resolve against the root. Prefix them with `**/` (e.g. `'**/.next/**'`).
- **`next/jest` needs `dir: __dirname`.** It resolves `dir` against `process.cwd()`, which is the
  repo root under the Nx jest executor.
- `typecheck` runs `tsc --build` over TS project references: libs are `composite`, apps reference
  `libs/<lib>/tsconfig.lib.json`. After adding a lib import to a project, run `npx nx sync`.
- **Builds are transpile-only; always run `nx typecheck` (or `nx run-many -t typecheck`) before committing.**
  The service webpack configs set `typeCheckOptions: false`: the in-build checker can't resolve lib
  project references until their `.d.ts` exist, so it broke clean builds (TS6305).
- `next-env.d.ts` and `*.tsbuildinfo` are generated and gitignored; don't commit them.
- **Tests must use real DB query keys and real request shapes.** Mocks with alternate formats hid broken
  trading: specs used `EURUSD` while the DB holds `EUR/USD` and Redis `price:EUR_USD`, and DTOs were
  built with fields the UI never sent. Assert the exact query/where clause and validate request bodies
  through the real `ValidationPipe` options.

## Current status
- Phases 1–6 (5 services + frontend: trading terminal, backtesting, economic calendar) were built by ~June 2026 and **haven't been run since**, so verify before assuming anything works.
- Never deployed. Earlier attempts hit many issues.
- **Roadmap step 1 (health check) is done** (2026-10-09): infra healthy, all 9 projects pass build,
  lint (0 errors), typecheck and tests from a clean `dist/`, all 5 services start from the repo root,
  and paper trading works end to end in the browser (orders, live positions/account, session restore).
  Write-up: `docs/phase-summaries/step-1-health-check.md`.

### Deferred from the health check
- `npm audit`: 88 vulnerabilities (7 critical). Don't run `npm audit fix --force`; review upgrades deliberately.
- `minio/minio` is no longer anonymously pullable (see step 7). The pinned release only runs where the
  image is cached; a `docker save` backup lives outside the repo.
- Lint warnings remain (mostly `no-explicit-any` and unused vars), 0 errors.

## Roadmap (in order)
1. ✅ **Done (2026-10-09).** Health check: infra up, all projects build and serve, fix breakages.
2. Historical data seed: M1 bid and ask OHLC candles (float8), 2010–2022, for **4 pairs: EUR/USD, GBP/USD,
   USD/JPY, XAU/USD**. Source: Dukascopy, exported with the official JForex strategy API by
   `tools/market-data/jforex/ForexEdgeM1Export.java` (see its README; a free JForex 4 demo login is enough).
   Dukascopy's HTTP endpoints sit behind bot protection and its S3 export needs AWS, so dukascopy-node and
   scraping are out; never work around the bot protection.
   More pairs can be added later, one pair at a time (export, import, validate). A cross pair (e.g. EUR/GBP)
   also needs its USD conversion pair's history (GBP/USD), because margin and pip value convert via quote→USD.
   M1 goes into its own `historical_candles` hypertable (PK `(pair, time)`, compression). M5/M15/H1/H4/D1 are
   continuous aggregates on it; H4 and D1 are aligned to the New York 17:00 close (5 daily bars a week).
   The import script must be idempotent (safe to re-run). Routing is explicit: the candle API takes
   `source=live|historical` (default live) and never mixes the two; the backtester always reads historical.
   Production deploys only H1 and above.
   First purge the mock data still materialized in the candle continuous aggregates (2024-01/02, 2026-05/06
   and later runtime checks; the raw ticks are gone, the candles_* views are not).
   XAU/USD integration: instruments row (100 oz lot, pip 0.01, `max_leverage` 20 → effective leverage is
   min(account, instrument)). Margin, pip value, P&L and paper fills already read lot_size/pip_size from the
   DB (step 1). The frontend's MAJOR_PAIRS, PAIR_DISPLAY, PairTabs and BacktestClient list only the 4 pairs
   (EUR_GBP removed there); the other instrument rows stay in the DB untouched. Verify pip value, margin and
   P&L for gold with an end-to-end order.
   Restart resilience (done in 2.7b): sessions are computed from the shared market clock.
   For 2.5: the backtester treats the historical data as the truth and never applies the live market-hours
   clock (gold traded through its 17:00-18:00 New York break in 2010-2012).
3. Backtest verification: re-run strategies on the historical data. The all-zero
   metrics were caused by mock random-walk data. Confirm they're fixed and fix anything remaining.
   ws-gateway has no tests yet (`passWithNoTests`): add backtest engine tests. Clear the stale BullMQ
   `bull:backtest:*` jobs left in Redis from earlier runs.
4. Python ML service: LSTM price prediction (trained on the seeded history) + FinBERT sentiment.
5. Research agent: Python/FastAPI + LangGraph + MCP, forex news and economic analysis per pair.
6. Real market data: Twelve Data API behind `USE_MOCK_DATA` (OANDA unavailable in India).
   Live `candles_4h` and `candles_1d` are UTC-aligned while the historical H4/D1 are New York-close aligned;
   realign the live views to the NY close here.
   Known gap: the economic-calendar scraper has produced nothing since 2026-06-13 (it runs only at
   00/06/12/18 UTC and not on startup, so it misses whenever the services are down then); fix it with the
   real data feeds.
7. Deployment (no credit card): Vercel, Aiven (TimescaleDB + Valkey), Cloudflare R2, free-tier service host.
   Refresh-token cookie needs `secure: true` and `sameSite: 'none'` for cross-origin (Vercel → backend); make it env-driven.
   MinIO community images are no longer pullable. Replace local MinIO with an R2 dev bucket or another S3-compatible image.
   Re-check Dukascopy's terms of use before a public deployment serves its historical data.
   Health endpoints: market-service and domain-service have no root/health route (`/api` 404s);
   add a health check to every service for the host's probes.
8. Known gaps: `forex.calendar-events` has no consumer (and its producer has never fired). The economic calendar
   is scraped every 6 h only at 00/06/12/18 UTC, so it is stale whenever the services weren't running then.

## How to work with me
- This is a portfolio and client project. Keep it production quality, with no shortcuts or simplified "demo" code.
- Explain the reasoning behind architectural decisions. I'm strong on backend and a beginner on frontend.
- For any non-trivial task, plan first and wait for my approval. Work in small phases and verify each one (build, test, run) before moving on.
- Diagnose errors from the actual files and logs, not assumptions.
- Don't rewrite working, completed modules unless the task requires it. Prefer adding new files.
- At the end of each phase, give a summary: what changed, errors hit with root cause and fix, key decisions, commands used, and interview Q&A.
- **No synthetic data, ever.** Historical data must be real market data (Dukascopy).
  Never generate, interpolate, or fabricate prices to make a test or backtest pass.
  The mock live feed (`USE_MOCK_DATA`) stays only until Twelve Data is integrated in roadmap step 6.

## Verification policy (keep it fast)
- While working on a change: run only the affected project's tests, and a single test file
  where possible (`npx nx test order-service --testFile=x.spec.ts`).
- Before each commit: `npx nx affected -t lint typecheck test build --parallel=2`
  (cache ON, daemon ON). Never use `--skip-nx-cache` or `NX_DAEMON=false` unless debugging a cache problem.
- Full clean matrix (`nx reset`, delete dist/, run everything): only at the end of a roadmap step.
- Start services or the browser only when the change affects runtime behavior or UI,
  and only the services involved.
- Run anything over ~2 minutes in the background and keep working meanwhile.
