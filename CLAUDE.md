# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ForexEdge is a forex trading platform built as an Nx monorepo (npm workspaces). It has five NestJS microservices that talk over Kafka, a sixth NestJS service for bar replay over the history (`apps/replay-service`, no Kafka), a Python FastAPI ML service (`apps/ml-service`, inference only), a Python research agent (`apps/research-agent`, LangGraph + MCP, read-only), a Next.js 16 frontend, and four shared libraries. Trading is paper-only for now: order-service binds `BROKER_ADAPTER` to `PaperBrokerAdapter`.

## Commands

Run every command from the repo root. Each Nx target has the form `npx nx <target> <project>`.

```sh
# Infra: TimescaleDB (host port 15432), Redis, Kafka (KRaft), MinIO, Prometheus, Grafana
docker compose -f infra/docker-compose.yml --env-file .env up -d

# Run a service (serve builds with webpack first, then runs the dist output)
npx nx serve auth-service        # also: market-service, domain-service, order-service, ws-gateway, replay-service
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

# Historical M1 import (Dukascopy exports in data/raw/jforex/, idempotent; see tools/market-data/import)
npm run data:import -- --years 2022 [--pairs EURUSD,XAUUSD] [--force EURUSD:2022] [--dry-run]
npm run data:import -- --check-only
npm run data:validate        # FRED noon fixings + gold extremes -> docs/validation/historical-spot-checks.md
npm run data:transfer -- export|import|check [--dir data/history-transfer]   # history dev -> prod (docs/DEPLOY.md)

# Production stack (docs/DEPLOY.md): images, bootstrap, local run behind Caddy on https://localhost
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.local.yml --env-file infra/.env.local-prod up -d
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod --profile ops run --rm ops \
  npx ts-node --transpile-only tools/ops/bootstrap-prod.ts   # migrations, instruments, logins, demo users
node infra/check-compose.mjs                                 # only Caddy publishes ports; limits, healthchecks...
npm run prod:smoke                                           # the stack in a browser over HTTPS + memory

# AWS infrastructure (infra/terraform, Terraform 1.16.7 exactly; docs/DEPLOY.md section 7). Offline only:
# Claude never runs plan/apply or anything against AWS; the owner does, with SSO
npm run infra:check                                  # fmt, source rules, validate, terraform test (mocked), tflint, shellcheck
bash infra/terraform/tests/planted-faults.sh         # every rule's planted fault must be caught (stage changes first)

# DB integration tests run in <DB_NAME>_test, created and migrated per run
RUN_DB_TESTS=true npx nx test market-data-import --testFile=importer.db.spec.ts

# Independent backtest verification (auth-service + ws-gateway running): API run vs SQL reproduction
npm run backtest:verify -- [--pairs EUR_USD,XAU_USD] [--from 2022-01-01] [--to 2022-12-30]

# Replay (replay-service, :3008): its DB login from REPLAY_DB_USER/REPLAY_DB_PASS, then the equivalence check
npx ts-node --transpile-only tools/ops/create-replay-db-user.ts
npm run replay:verify -- [--pairs EUR_USD,XAU_USD,USD_JPY]   # auth-service + replay-service running; replays the
                                                            # verified trades of docs/validation/backtest-verification.md
npm run replay:e2e                                          # end-to-end run -> docs/validation/replay-backend-e2e.md
npm run replay:browser                                      # Replay page in Playwright's Chromium (auth + replay-service
                                                            # + production frontend :4200) -> docs/validation/replay-frontend-e2e.md
npx ts-node --transpile-only --project tools/replay-verify/tsconfig.app.json tools/replay-verify/src/record-frontend-fixtures.ts
                                                            # re-records the Replay page's fixtures (auth + replay-service)
RUN_DB_TESTS=true npx nx test replay-service --skip-nx-cache  # + DB/socket suites (real minutes, replay login)
npx ts-node --transpile-only tools/ops/delete-verification-users.ts [--apply]   # throwaway verify_*/replay* users

# ML service (Python 3.12, apps/ml-service; see its README)
npx nx setup ml-service                         # venv + hash-checked install of the lock files
npx nx run-many -t lint typecheck test -p ml-service    # ruff, mypy --strict, pytest
npx nx serve ml-service                         # :3006, /api/ml
npx nx train ml-service --args="--out models"   # offline walk-forward training (resumable)
npx ts-node --transpile-only tools/ops/create-ml-db-user.ts   # read-only DB login from ML_DB_USER/ML_DB_PASS

# Research agent (Python 3.12, apps/research-agent; see its README)
npx nx setup research-agent
npx nx run-many -t lint typecheck test -p research-agent     # default suite never calls the LLM
RUN_DB_TESTS=true RUN_LIVE_ML=true npx nx test research-agent  # + dev DB tools, ml-service (running) tools
npx nx serve research-agent                     # :3007, POST /api/research/ask
npx nx run research-agent:eval                  # opt-in live eval (free-tier LLM quota, ml-service running)
npx ts-node --transpile-only tools/ops/create-research-db-user.ts   # login from RESEARCH_DB_USER/RESEARCH_DB_PASS
npx ts-node --transpile-only tools/ops/research-demo-data.ts        # demo users + verified runs (auth + ws-gateway up)
# (in apps/research-agent, auth-service + research-agent [+ frontend] running; each question spends LLM quota)
.venv/Scripts/python.exe scripts/record_ask_fixtures.py answer refusal not-in-data too-long   # Research page fixtures
.venv/Scripts/python.exe scripts/e2e_research_page.py          # HTTP e2e -> docs/validation/research-page-e2e.md
```

## Architecture

### Services and ports
All backend services use the global prefix `/api`, and answer `/health/live` and `/health/ready` outside it (no auth,
dependency names only; `HealthModule` in `@forexedge/common`). CORS comes from `CORS_ORIGIN` (comma list, required
when `NODE_ENV=production`); unset, the dev default is `localhost:4200` and `localhost:3001` (research-agent: 4200
only). In production everything is one origin behind Caddy (`infra/caddy/Caddyfile`, routes in docs/DEPLOY.md).

| Service | Port | Responsibility |
|---|---|---|
| auth-service | 3000 | Register/login and JWT access + refresh tokens (refresh token in a cookie). Argon2 password hashing. **Owns all DB migrations and seeds** for the whole system. |
| market-service | 3002 | Live feed per `MARKET_FEED` (libs/common `market-feed.ts`): `none` (default) starts no stream; `mock` = `MockStreamProvider`, simulated prices for development only. No licensed live provider yet. Publishes `forex.ticks`; feed state (off/connected/degraded/down, reconnect with backoff, never a fallback) at `GET /api/market/feed/status`. Consumes its own ticks to write them to TimescaleDB (`ticks` only) and Redis. Serves candle and instrument queries. |
| domain-service | 3003 | Forex domain logic: pip calc, margin, swaps, session clock, spread monitor, economic calendar (events only, from the official FOMC and ECB calendars, synced once a day). Scheduled jobs publish `forex.sessions`, `forex.spread-alerts`, `forex.calendar-events`. |
| order-service | 3004 | Orders, positions, account. Validates orders using live ticks, spread alerts, and session state from Kafka. Publishes `orders.lifecycle`. |
| ml-service (Python) | 3006 | FastAPI, inference only: LSTM next-H1-direction models trained offline walk-forward (`models/`, manifest + sha256). `GET /api/ml/{health,models,evaluation,predictions/{instrument}}`, JWT on all but health. Reads the history as the read-only login `forexedge_ml` (role `forexedge_readonly`). Results are a **historical walk-forward test, not live signals**. |
| research-agent (Python) | 3007 | FastAPI + LangGraph agent over a FastMCP stdio server (7 read-only tools: available data, bars, market stats, the caller's backtest runs, ML evaluation/predictions). `POST /api/research/ask` (JWT) returns a structured report whose every number is checked by a deterministic verifier. LLM from env (`RESEARCH_LLM_MODEL`, default `groq:openai/gpt-oss-120b`, free tier). DB login `forexedge_research` (roles `forexedge_readonly` + `forexedge_research_reader`); calls ml-service with the caller's own token. |
| replay-service | 3008 | Bar replay over the imported 2010-2022 history (step 6b-1). REST `/api/replay/sessions` (create: 409 `{activeSessionId}` while one is active; `active`; `active/end`), `active/orders`, `active/orders/:id/cancel`, `active/positions/:id/close`; Socket.IO namespace `/replay` on path `/api/replay/socket.io` (JWT in `handshake.auth.token`, room `user:<id>`; commands play, pause, step, setSpeed, setTimeframe, reauth, acked `{ok, result or error}`; events state, bar, account, positions, status, endOfData, ended). Trades through `@forexedge/trading-sim`. DB login `forexedge_replay` (roles `forexedge_readonly` + `forexedge_replay_writer`). **No Kafka, no Redis.** |
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
- `@forexedge/common`: broker interface and the `BROKER_ADAPTER` DI token. `@forexedge/common/money` is the money file
  alone (margin, pip value), for code that must not pull in the barrel's NestJS imports.
- `@forexedge/trading-sim`: the trading rules shared by the backtester and replay, pure functions on integer points
  (fills, SL/TP `levelExit`, USD money and commission, mark to market, margin). No I/O, NestJS, TypeORM or Kafka, and
  only `@forexedge/common/money` from common (a static test in replay-service enforces it).

### Per-service conventions
- Every service has its own small `redis/` module (with an injection decorator) instead of a shared lib.
- order-service and ws-gateway don't issue tokens. They validate JWTs from auth-service with their own `auth/jwt.strategy.ts` and `jwt-auth.guard.ts`, so the `JWT_ACCESS_SECRET` values must match.
- Config comes from `@nestjs/config` with `ConfigModule.forRoot({ isGlobal: true })`, which reads `.env` from the cwd, so every service (and `npm run migration:*`) runs from the repo root, which has the only `.env`. Docker Compose needs `--env-file .env` because the compose file lives in `infra/`. Postgres and Redis support TLS through env flags (e.g. `DB_SSL=true`) for managed hosting (Aiven).

### Git conventions
- **No Claude attribution in commits or PRs:** no `Co-Authored-By: Claude ...` trailer, no "Generated with Claude Code"
  line, nothing similar, in any commit message or PR description. `.claude/settings.json` turns Claude Code's
  attribution off (`attribution.commit` and `attribution.pr` empty, `sessionUrl` false). Existing history is not rewritten.

### Frontend (`apps/frontend`)
- Next.js App Router with route groups `(auth)` and `(dashboard)`, Tailwind, Radix UI, and `lightweight-charts`.
- State uses Redux Toolkit. RTK Query APIs in `src/store/api/*.api.ts` all extend `baseApi`, which attaches the bearer token from the store. The access token is **in memory only** (never localStorage); on app load `SessionRestorer` restores the session from the httpOnly refresh cookie, and `AuthGuard` waits for it. On a 401, `baseApi` awaits `refreshSession()` (`src/lib/session.ts`), stores the new token, then retries.
- Every API and socket is called on the page's own origin (`/api/...`, `/socket.io`, `/api/replay/socket.io`;
  `src/lib/constants.ts`): Caddy routes them in production, `next dev`'s rewrites (`next.config.js`, socket paths
  with their trailing slash) in development. A production build has no rewrites and no localhost address
  (`apps/frontend/scripts/check-production-build.cjs`, run in the Docker build). Live data comes through
  `hooks/useForexSocket.ts`, mounted once in the dashboard layout (`LiveConnection`); the Topbar dot follows
  ws-gateway's `feed:status` (green only for a real feed with a real recent tick).
- **Tokens on sockets (step 7):** every JWT is HS256 with issuer `forexedge-auth` and audience `forexedge-api`
  (refresh: `forexedge-refresh`), shared from `@forexedge/common` `jwt-claims.ts` by every verifier (the Python
  services test their copy against it). Both gateways disconnect a socket at its token's expiry (`authExpired`);
  `useTokenRefresh` refreshes a minute before, the replay socket sends it as `reauth`, the ws-gateway socket reads
  it at its next connect. `refreshSession()` holds a Web Lock across tabs (refresh tokens rotate). A failed
  refresh ends the session as `sessionExpired` ("Session expired, please log in"), never a reconnect loop.
- `REGISTRATION_ENABLED` (unset = closed): the Register link and page follow `GET /api/auth/config` at runtime.
- Instrument symbols use OANDA format (`EUR_USD`).
- **Research page (`/research`, step 5b):** `askResearch` is a mutation with a 100 s timeout and no retry wrapper
  (every call spends free LLM quota); one request in flight; the question limit (3-500 code points) mirrors
  research-agent's `MAX_QUESTION_CHARS`. Report text renders only as React text nodes (no
  `dangerouslySetInnerHTML`, no markdown), values exactly as returned (the verifier checked those strings), and
  `could_not_verify` shows a fixed warning only, never `answer`, `claims` or `verification.failures` (a failure
  message can quote the rejected number). Component tests use real recorded `/ask` bodies
  (`components/research/__fixtures__`, sha256 in its manifest).
- **Replay page (`/replay`, step 6b-2):** the server owns everything; the page keeps the latest copy in the `replay`
  slice (a `state` replaces it all, `bar`/`account`/`positions`/`status` replace their part, positions by id).
  `useReplaySocket` opens one socket per page visit to replay-service `/replay`; the token is read from the store on
  every (re)connect (`auth` callback), never captured, so a token refresh doesn't tear the socket down (a disconnect
  would pause the replay). A `replayError` 'Unauthorized' runs `refreshSession()` once and connects again. The page
  never sends `play` by itself. The chart draws **bid** candles: `setData` on a new state (`stateVersion`),
  `update` for a bar event; a bar of another timeframe is ignored. Money and prices stay decimal strings (USD
  formatted from cents as BigInt). Each open position's P&L is computed with `@forexedge/trading-sim`'s
  `markToMarketCents` at the current bar's close (the server sends only the total; a test checks the rows add up
  to `unrealizedPnlUsd`). On /replay the Topbar hides the live ticker and shows "Historical replay". Component
  tests use recorded replay-service bodies and socket events (`components/replay/__fixtures__`, written by
  `record-frontend-fixtures.ts`, sha256 in its manifest).


## Environment
- Windows + Docker Desktop on the WSL2 backend (its disk is `docker_data.vhdx`, which never shrinks by itself). Node v24+, Nx v22.
  Every block Docker writes grows the vhdx, even short-lived ones: Postgres temp files from big sorts/aggregations
  (at the default 4 MB `work_mem` one run of the historical checks spilled ~6 GB) and the build cache. Heavy
  historical queries set `work_mem = '256MB'` for their own session. `docker system df` reports Kafka's volume at its
  apparent size (preallocated sparse 10 MB index files); measure real usage with `du` inside a container.
- **Use Git Bash only.** PowerShell 5.1 crashes at startup in this environment
  (`InitialSessionState` type initializer exception), so don't use it.
- Docker Desktop doesn't auto-start; launch it before `docker compose up`.
- Use Windows-compatible commands. In Git Bash, wrap Docker commands that use paths in `bash -c "..."`,
  and set `MSYS_NO_PATHCONV=1` for `docker exec` with container paths (e.g. `/opt/kafka/bin/...`).
- Local Postgres 13/15 occupy 5432/5433, so TimescaleDB is on host port **15432**. Don't change it.
- Docker Desktop on Windows can reset IPv6 connections to forwarded ports ([::1]:15432, [::1]:9092) while 127.0.0.1
  works; Node 24 tries localhost as IPv6 first. Use 127.0.0.1 for DB/Redis/Kafka hosts in .env.
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
- `historical_candles` stores integer points: price = value × 10^price_decimals, volume = value × 10^6, with the
  scale fixed per pair in `historical_price_scale` (EUR/USD and GBP/USD 5, USD/JPY and XAU/USD 3). Convert with
  that table, never with `instruments.pip_size`. Float8 compressed 2.9×, integers 7.7× (decimal floats have noisy low bits).
- `refresh_continuous_aggregate` only materializes buckets entirely inside the window. The New York-aligned
  historical H4/D1 bars start at 21:00/22:00 UTC, so never refresh them in yearly windows (the Dec 31 evening bar
  crosses the UTC year and is lost); the importer refreshes them in one window padded a week each side.
- Integration tests that touch the DB use `createTestDatabase()` (`@forexedge/database/testing`): it drops, creates
  and migrates `<DB_NAME>_test` and refuses any name not ending in `_test`. Never point a test at the dev DB.
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
  OpenPairsIndex, MarketHoursPolicy, PriceFeedPolicy, StopOutService and AccountInvariantMonitor are provided once, by
  `KafkaConsumerModule`. Don't also list them in AppModule (duplicate instances have separate state).
- Market hours come from the shared clock `libs/common/src/lib/market-hours.ts` (FX Sun 17:00 to Fri 17:00 New York;
  metals open Sun 18:00 and pause 17:00-18:00 Mon-Thu). Orders and manual closes are rejected while closed; SL/TP
  changes and cancels are allowed. order-service's tick consumer ignores ticks stamped while closed. Dev-only flags,
  both strictly `true`/`false`: `MARKET_HOURS_GATE=false` (order-service) and `MOCK_STREAM_WHEN_CLOSED=true`
  (market-service), used together to trade on weekends. Sessions on orders come from the same clock.
- **Price safety (step 6a):** order-service trades only prices from the configured `MARKET_FEED`'s sources, no older
  than their maximum age (`MAX_PRICE_AGE_MS`, MOCK 2 s), checked explicitly in `PricingService.getQuote`
  (`PriceFeedPolicy`, reasons "No live price for EUR/USD" / "Price for EUR/USD is stale: last quote N s old (max M s,
  source X)"). The tick consumer drops untradable ticks before SL/TP and P&L (a backlog after a restart no longer
  triggers exits at old prices). With no feed (the default) every order is rejected. A provider error publishes
  nothing (prices age out); there is never a fallback to the simulator. `MARKET_FEED` must be exactly `none` (the
  default, also when unset) or `mock`; anything else fails startup. Tests that need the
  feed pass it as a value, never through `ConfigService` (Nx loads the root `.env` into `process.env`, which wins).
- Redis `price:<INSTRUMENT>` also expires 2 s after the last tick.
  `price:last:<INSTRUMENT>` has no expiry and is only a reference (validating SL/TP while the market is closed).
- **Live ticks never touch `historical_*`**: the only live write path is `insertLiveTick` (`libs/database`
  `live-ticks.ts`, into `ticks`); a static test (market-service `historical-isolation.spec.ts`) and a DB test
  (market-data-import `live-isolation.db.spec.ts`) enforce it. Only `tools/market-data/import` writes the history.
- **Mixed candles (hard rule):** the live `candles_*` aggregates don't separate ticks by source, and `ticks` holds
  MOCK ticks. Before any live provider is enabled, either delete the MOCK ticks and their candles or add `source`
  to the live aggregates; never show simulated history as market data.
- **Economic calendar (step 6a):** events only (domain-service `economic-calendar/`). FOMC and ECB from official
  sources: FOMC (federalreserve.gov, public domain) and ECB (ecb.europa.eu, free use with attribution). All other
  events via Forex Factory (`forexfactory/`, see the data-licensing exception). Direct BLS access is blocked (HTTP 403,
  2026-11-06; branch `step-6a-bls-wip`). Each official page is fetched at most once per UTC day, and the Forex
  Factory export at most twice (06:15 and 18:15; a Redis claim per source and slot), with the
  `CALENDAR_USER_AGENT`; strict parsers throw on unexpected
  markup and the service keeps the last good events. Every event is stored at its release moment in UTC
  (`scheduled_at`), converted from the source's local time with IANA zones (`zoned-time.ts`, DST included, never a
  fixed offset), and `time_source` says where the time comes from: `official` (ECB decisions, 14:15 Frankfurt, from
  the ECB's monetary policy decisions page) or `expected` (FOMC: the Fed publishes no standing time; 14:00 New York
  on a meeting's final day, the time on the last 8 recorded statements, `__fixtures__/fomc-statements/`, never
  fetched at runtime), or `third_party` (Forex Factory: the time with the UTC offset its export gives; no zone is
  ever assumed). Only events with such a time are stored (no Day 1, notation votes, non-monetary meetings; Forex
  Factory holidays, Non-Economic and local-midnight entries are skipped and counted, and its rows for the FOMC/ECB
  decisions are dropped as duplicates). A Forex Factory sync replaces exactly its export's week in one transaction.
  Titles are the sources' wording; impact is a fixed ForexEdge classification (`impact.ts`) for FOMC/ECB and
  ForexFactory's own level for its rows, labelled as such; the UI cites the sources and marks "via ForexFactory".
  Forecast/previous/actual are null. A test fails on the Forex Factory name outside its adapter, the places that wire
  it in or show it, and docs. Recording new fixtures is opt-in (`tools/ops/record-calendar-fixtures.ts`).
- **Data licensing exception:** ForexFactory calendar export — approved by the owner on 2026-11-06 for portfolio use;
  terms not confirmed for commercial use; must be re-checked or replaced before any client/commercial use. Never work
  around their bot protection (no browser-like or changed headers, headless browsers or proxies; a 403/429/challenge
  is logged and skipped).
- **Personal data in outbound requests:** never put the owner's personal data (email etc.) in outbound requests
  (User-Agent, headers, query strings) without explicit approval. The ONLY approved case: CALENDAR_CONTACT_EMAIL in the
  official-calendar User-Agent, read from .env. Currently no outbound request carries personal data. A project contact
  email for BLS is approved but unused (branch step-6a-bls-wip). Tests: no calendar User-Agent carries an email, and no
  tracked file contains the owner's addresses (matched by sha256, `no-personal-data.spec.ts`).
- A triggered stop-loss/take-profit is committed on the position (`pending_exit_*`) before it is booked and is retried
  from the DB, so a restart can't lose it. It books at the triggering tick's price, never the SL/TP level.
- Stop-out (margin level < 50%) closes the biggest loser first until the level is back above 50%; close_reason
  `STOP_OUT`. `MARGIN_CALL` is a log warning only and is never written to open positions.
- **Backtests read only the imported history** (shared reader `libs/database/src/lib/historical-candles.ts`,
  coverage from `historical_coverage`), never the live `candles_*`, and never apply the live market-hours clock.
  A signal fills at the NEXT bar's open (buy at the ask, sell at the bid); SL/TP are checked from the fill bar on
  long on bid, short on ask), gaps fill at the open, SL wins if both are inside one bar. Pips = points /
  (pip_size x 10^decimals); pip size always comes from `instruments`.
- **Backtest money is USD, from integer points** (`ws-gateway/src/backtest/trade-money.ts`): units = lots x
  `instruments.lot_size` (must be whole); USD-quoted pairs `points x units / 10^decimals`, USD/JPY
  `points x units / exitPoints` (converted at the trade's own exit fill); cents rounded half away from zero (as
  Postgres `round(numeric)`), using BigInt. A pair without a USD leg is rejected.
- Backtest metrics (`metrics.calculator.ts`): equity marked to market at every bar close (open trade at the
  bid/ask close, commission deducted); max drawdown % of the running peak; Sharpe from daily returns at the
  Mon-Fri New York 17:00 closes taken from the calendar (not D1 bars), sample stdev, x √260, rf 0. A metric that
  is undefined (no trades, no loss, < 2 returns) is **null** and shows as "—"; never store a fabricated 0 or 999.
  No margin/stop-out in backtests. Final equity is derived (initial_capital + total_pnl_usd), not stored.
- **Backtest dates are inclusive calendar days (UTC)**: `YYYY-MM-DD` only; the window is [From 00:00, the day
  after To 00:00) and only whole bars inside it are used (`backtest-window.ts`), so To = Wednesday never pulls in
  the NY-aligned D1 bar that starts Wednesday evening.
- **Indicator comparisons must be exact.** MA crossover compares integer sums of (bid + ask) points
  cross-multiplied, never float SMAs: a real exact tie (EUR/USD 2022-01-03 12:47, SMA 5/20) flipped a float
  comparison and signalled a bar early. The independent SQL reproduction (`tools/backtest-verify`) only matches
  because both sides are exact; keep any new strategy verifiable the same way.
- **ML service rules:** a prediction for bar t+1 is served only by the model whose test year contains it (2016-2022,
  out of sample); features use bars <= t only and scaling uses training-period statistics only (both tested).
  Every model change goes through `python -m ml_service.report`, which must keep the SQL recount, the reproducibility
  (state_dict tensors equal; `torch.save` file hashes are not byte-stable) and the parity checks green. The decision rule
  (pooled McNemar, Holm over 16 tests) is fixed in `ml_service/metrics.py`; don't change it after seeing results.
  The ML service's DB login is read-only by role and by session; never give it the main DB user.
- Python deps: exact pins in `apps/{ml-service,research-agent}/requirements*.in`, locked with sha256 by `scripts/add_hashes.py`
  (PyPI JSON; refuses releases younger than 14 days). Don't use `pip-compile --generate-hashes` (downloads every torch wheel).
  A dependency whose ownership can't be proven (e.g. no PyPI provenance) isn't added. httpx2 is unproven, so
  research-agent holds back mcp at 1.30.0 (2.x needs httpx2) and langsmith at 0.11.2 (0.12+ needs httpx2); check
  this before bumping either. langchain-mcp-adapters 0.3.2 and redis 8.1.0 were accepted by a byte diff against their
  tags (README). The Docker images use `requirements.linux.lock`, derived by `tools/python/linux_lock.py` (no pywin32,
  torch's CPU build from PyTorch's index); a test fails if it drifts from `requirements.lock`. The Nx Python
  targets run through `tools/python/run.cjs` (the venv's python on Windows or Linux).
- **Research agent rules:** every number in an answer must be a claim that the verifier (`research_agent/verifier.py`,
  no LLM) matches to a unit-suffixed field of a successful tool call (prices at the pair's price_decimals, pct/pips
  with >= 3 significant digits, counts/USD exact, signed, no unit conversion); otherwise the response is
  `could_not_verify`, never the unverified text. Tool output fields carry their unit as a suffix (`_price`, `_pct`,
  `_pips`, `_usd`, `_count`, ...): keep that for any new field. Backtest tools filter by the caller's user id in
  every WHERE clause (one DB login serves all users). The caller's token reaches ml-service only through the MCP
  child's environment, never tool arguments. The default test suite must never call the LLM (transcripts are
  replayed); record new ones with `scripts/record_transcripts.py`.
- Only MARKET orders are executed; LIMIT/STOP/... are rejected (no pending-order engine yet). SL/TP must sit on the
  right side of the exit price (LONG: SL < bid < TP; SHORT: TP < ask < SL), at placement and on PATCH.
- **Replay rules (step 6b-1, replay-service):**
  - **The server owns the clock** (`replay_sessions.clock_time` = the last processed M1 minute) and never sends
    anything after it: the current bar is rebuilt from M1 minutes up to the clock (the aggregate row of an unfinished
    bucket is never read), history is the completed aggregate bars before the current bucket (500), and every emitted
    payload passes `assertNothingAfterClock`. Buckets use `historicalBucketSql` (`@forexedge/database`), the
    aggregates' own expressions; a DB test rebuilds every 5m-1d row from M1.
  - **One bar per step**: the next bar's minutes (weekends and gaps skipped) run in order through the engine, then
    positions, balance (relative update) and clock are saved in one transaction, then bar/positions/account are sent.
    Per minute: requested closes at the open, then pending orders at the open, then SL/TP from the fill minute on.
  - **Fills are the backtester's next-open rule**: an order or close placed at clock t is PENDING and fills at the
    next processed minute's open (BUY at the ask, SELL at the bid; a long closes at the bid). SESSION_END closes at
    the clock minute's close. Money, commission (0.7 pip/side) and USD/JPY conversion are trading-sim's; replaying the
    verified backtest trades gives the same trades to the cent (`npm run replay:verify`).
  - Validation at the clock minute's close: SL/TP whole points on the right side; margin = `marginRequiredUsd`
    (1:100 capped by `max_leverage`) at the side's close vs free margin = equity - margin of OPEN + PENDING. Equity =
    balance + mark to market at the clock close. **No stop-out or margin call** (none in the backtester).
  - Speeds are exactly 500, 1000 or 2000 ms per bar. One chained timer per PLAYING session (token-guarded); every
    command, order and step runs under the per-session `SessionLock`. The last socket leaving pauses and saves, a
    connecting socket always gets a PAUSED state (also a second tab), a boot or clean stop pauses every PLAYING
    session, and the end of the history pauses with `endOfData`. **Single instance only** (in-process timers/lock).
  - **Pause reason** (`replay_sessions.pause_reason`, step 6b-2, in `state` and `status`; null unless PAUSED): USER
    (pause), OTHER_TAB (a socket connected while another of the user's was connected; replaces USER/DISCONNECT on a
    paused session, never END_OF_DATA; the other sockets get a `status`), DISCONNECT (the last socket left while
    playing; a lone reconnect keeps it), SERVER_RESTART (boot or clean stop), END_OF_DATA. A step that fails while
    playing pauses with no reason and sends a `status`.
  - One non-ENDED session per user (partial unique index). The replay login can't write `historical_*`, `ticks`,
    `candles_*` or `instruments`, and can't read users/orders/live ticks; replay-service refuses to start as `DB_USER`.
  - Tests use real minutes only: `test/replay-test-db.ts` loads the importer's real fixtures into `<DB_NAME>_test`
    with the real instruments seed (the only cross-project imports, test code) and connects as a temporary login
    with the replay grants; `test/replay-app.ts` runs the real AppModule in-process.

### Terraform rules (`infra/terraform`)
- No secret in any variable, resource argument or output: state is plain JSON in the S3 state bucket.
  `*.tfvars`, `.terraform/` and `*.tfstate*` are git-ignored; only `terraform.tfvars.example` (placeholders) is committed.
- IAM policies are `jsonencode()`, never `aws_iam_policy_document` (a data source is random under
  `mock_provider`, so it couldn't be tested); ARNs the tests compare are built from names in `locals.tf`.
- `terraform test -filter` needs the platform's path separator: with `tests/x.tftest.hcl` on Windows it finds
  nothing, warns and **passes**. check.sh and planted-faults.sh fail on a run of zero tests.
- Map attributes compare equal only to `tomap({...})`, sets only to `toset([...])` (an object literal is a
  different type and the assertion is simply false).

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
- Production frontend: `npx nx build frontend && npx nx run frontend:serve:production` (port 4200).
  `nx start frontend` fails: it runs `next start` in `apps/frontend`, but the build is in `dist/apps/frontend`.
- **The Nx daemon can serve stale cache for a project directory created after it started** (seen on Windows: edits to
  a new spec replayed an old result with fewer tests). After adding a project, run `npx nx daemon --stop`, and confirm
  a new test file actually runs.
- **Jest's inferred `test` targets don't hash `RUN_DB_TESTS`**, so a DB run right after a normal run replays the
  cached "skipped" result. Run DB suites with `--skip-nx-cache` (the Python targets list it as an input).
- **On Windows an empty env var is unset**, so `VAR= npx nx ...` doesn't override a value in `.env` (Nx loads it into
  every task). To run without a key (e.g. the clean matrix without `GROQ_API_KEY`), comment the line out and restore it.
- **jsdom has no `fetch`/`Request`/`Response`.** A component test that goes through RTK Query's real
  `fetchBaseQuery` uses `/** @jest-environment ./test/jsdom-with-fetch.cjs */` (Node's fetch classes, including
  Node's AbortSignal). fetchBaseQuery's `timeout` leaves a timer running after a fast response, so those specs use
  fake timers and `jest.clearAllTimers()`, or Jest reports a worker that failed to exit.
- **Frontend component specs share the singleton store**: reset the RTK Query cache in `beforeEach`
  (`store.dispatch(baseApi.util.resetApiState())`), or a later test is served an earlier test's response.
- **`nx run <p>:<t> --args='...'` turns commas inside the args into spaces** (seen with the eval's `--note`).
  Avoid commas in such arguments, or run the module directly.
- **Workspace libs in the frontend:** Turbopack refuses a lib whose `package.json` says `"type": "commonjs"` while
  its sources use `import`/`export`; `libs/common` and `libs/trading-sim` therefore declare no `type` (CommonJS is
  Node's default, so the services are unchanged). Keep it that way for any lib the frontend imports. The frontend
  type-checks at `ES2020` (BigInt literals).
- **A stale Nx project graph** can drop a real dependency (seen: ws-gateway → trading-sim) and make `nx sync`
  remove a valid project reference. Don't commit such a sync; run `npx nx reset --only-workspace-data` and check again.
- **Every check fails on empty input.** A data check, validation or test assertion that compared zero rows must
  fail, never pass (an empty comparison once read as "equal"). Assert the count compared is > 0.
- **Tests must use real DB query keys and real request shapes.** Mocks with alternate formats hid broken
  trading: specs used `EURUSD` while the DB holds `EUR/USD` and Redis `price:EUR_USD`, and DTOs were
  built with fields the UI never sent. Assert the exact query/where clause and validate request bodies
  through the real `ValidationPipe` options.
- **Caddy sorts directives itself**: `respond` runs before `reverse_proxy` wherever it is written. Keep the routes
  in the Caddyfile's `route { }` block (in order), or a 404 rule swallows every API path (it did; caught by
  `npm run prod:smoke`, which checks that each prefix reaches its own service).
- **Docker Desktop resets IPv6 to published ports for every client**, Chromium too: browser runs against a local
  container use `--host-resolver-rules=MAP localhost 127.0.0.1`, Node `--dns-result-order=ipv4first`.
- **One refresh token per user**: an API login (a script) ends the same user's browser session at its next page
  load. Scripts that drive the browser take their API token before the browser logs in.

## Current status
- Phases 1–6 (5 services + frontend: trading terminal, backtesting, economic calendar) were built by ~June 2026 and **haven't been run since**, so verify before assuming anything works.
- Never deployed. Earlier attempts hit many issues.
- **Roadmap step 1 (health check) is done** (2026-10-09): infra healthy, all 9 projects pass build,
  lint (0 errors), typecheck and tests from a clean `dist/`, all 5 services start from the repo root,
  and paper trading works end to end in the browser (orders, live positions/account, session restore).
  Write-up: `docs/phase-summaries/step-1-health-check.md`.
- **Roadmap step 2 (historical data) is done** (2026-10-11), merged into main (PR #1).
  Write-up: `docs/phase-summaries/step-2-historical-data.md`.
- **Roadmap step 3 (backtest verification) is done** (2026-10-11), merged into main (PR #2).
  Write-up: `docs/phase-summaries/step-3-backtest-verification.md`.
- **Roadmap step 4 (ML service, LSTM only) is done** (2026-10-12), merged into main (PR #3).
  Write-up: `docs/phase-summaries/step-4-ml-service.md`.
- **Roadmap step 5 (research agent) is done** (2026-10-12), merged into main (PR #4).
  Write-up: `docs/phase-summaries/step-5-research-agent.md`.
- **Step 5b (Research page) is done** (2026-10-12), merged into main (PR #5). The manual browser check is pending
  (`docs/validation/research-page-e2e.md`). Write-up: §13 of the step-5 summary.
- **Step 6a (price safety + calendar) is done** (2026-10-12, follow-up 2026-11-06), merged into main (PR #7):
  exact UTC event times, Forex Factory for non-FOMC/ECB events, BLS parked on `step-6a-bls-wip` (403).
  Write-up: `docs/phase-summaries/step-6a-price-safety-calendar.md`.
- **Step 6b-1 (bar replay backend) is done** (2026-11-10), merged into main (PR #8):
  `@forexedge/trading-sim`, replay-service (3008), replay tables and login, playback over `/replay`, orders.
  Write-up: `docs/phase-summaries/step-6b-1-replay-backend.md`.
- **Step 6b-2 (Replay page) is done** (2026-11-10) on branch `step-6b-2-replay-frontend` (not merged): `/replay`,
  the pause reason, a Playwright browser run. Write-up: `docs/phase-summaries/step-6b-2-replay-frontend.md`.
  Deferred items: `docs/BACKLOG.md`.
- **Step 7 phase 1 (deploy readiness) is done** (2026-11-10) on branch `step-7-deploy-readiness` (not merged):
  health endpoints, token expiry on sockets, pinned JWT claims, live feed dot, closed registration + demo users,
  research quota, same-origin frontend, S3 results with the instance role, images, prod compose, Caddy, history
  transfer, bootstrap; the whole stack ran on the laptop over HTTPS (1.98 GB while a replay plays).
  Write-up: `docs/phase-summaries/step-7-deploy-readiness.md`; runbook: `docs/DEPLOY.md`.

- **Step 7 phase 2a (Terraform) is done** (2026-11-10) on branch `step-7-terraform` (not merged): `infra/terraform`
  (VPC, host, IAM, ECR, S3, GitHub OIDC deploy role, alarms, DLM), `infra/vm/setup.sh`, offline
  checks with planted faults. Nothing applied yet (the owner runs it). Runbook: `docs/DEPLOY.md` section 7.

### Deferred from the health check
- `npm audit`: 88 vulnerabilities (7 critical). Don't run `npm audit fix --force`; review upgrades deliberately.
- `minio/minio` is no longer anonymously pullable (see step 7). The pinned release only runs where the
  image is cached; a `docker save` backup lives outside the repo.
- Lint warnings remain (mostly `no-explicit-any` and unused vars), 0 errors.

## Roadmap (in order)
1. ✅ **Done (2026-10-09).** Health check: infra up, all projects build and serve, fix breakages.
2. ✅ **Done (2026-10-11).** Historical data: 19,187,987 real Dukascopy M1 bid/ask bars, EUR/USD, GBP/USD,
   USD/JPY, XAU/USD, 2010–2022, as integer points in `historical_candles` (7.5x compressed), with M5/M15/H1 (UTC)
   and H4/D1 (New York close) aggregates; validated against FRED noon fixings and gold extremes; candle API
   `?source=historical`; the backtester runs only on it. Write-up: `docs/phase-summaries/step-2-historical-data.md`.
   Source: the official JForex strategy API (`tools/market-data/jforex/`); Dukascopy's HTTP endpoints sit behind
   bot protection and its S3 export needs AWS, so dukascopy-node and scraping are out; never work around it.
   More pairs: one at a time (export, `historical_price_scale` row, import, validate). A cross pair (e.g. EUR/GBP)
   also needs its USD conversion pair's history, because margin and pip value convert via quote→USD.
   Production deploys only H1 and above.
3. ✅ **Done (2026-10-11).** Backtest verification: results in USD (initial capital, lots x lot_size, USD/JPY at
   the exit fill), marked-to-market equity, drawdown and daily NY-close Sharpe; inclusive To date; exact MA
   crossover. An independent SQL reproduction from raw M1 matches the API runs trade by trade and metric by
   metric (EUR/USD 257, XAU/USD 217, USD/JPY 215 trades, 2022 H1): `docs/validation/backtest-verification.md`.
   Write-up: `docs/phase-summaries/step-3-backtest-verification.md`. Not verified independently yet: London
   breakout (SL/TP path); a strategy added later needs its own reproduction.
4. ✅ **Done (2026-10-12), LSTM only.** Python FastAPI ML service: next-H1 direction LSTMs, walk-forward 2016-2022
   (4 pairs x 7 test years), read-only DB login, JWT API, read-only "Model evaluation" page. Fixed Holm rule: beats 9 of
   16 pair-baseline comparisons, never anti-persistence, below the spread break-even for every pair
   (`docs/validation/ml-walk-forward.md`). Shuffled-label control: original criterion fails for GBP/USD, corrected
   criterion (balanced-accuracy interval includes 0.5) passes for all four (docs/OVERNIGHT-QUESTIONS.md #3, resolved).
   FinBERT/news sentiment was taken out of step 4; GDELT headlines exist only from 2019-09-22 and their licences
   are unconfirmed. The Nx Python targets use Windows paths (Linux image in step 7).
5. ✅ **Done (2026-10-12).** Research agent (`apps/research-agent`): FastAPI + LangGraph + MCP (FastMCP, stdio, one
   server per request) answering questions about ForexEdge's own data only (history, the caller's backtest runs,
   ML evaluation), with a deterministic verifier, per-request budgets and a free-tier Groq model. News, web search,
   sentiment and the economic calendar were out of scope. Live eval: `docs/validation/research-agent-eval.md`.
   Step 5b: the frontend Research page (`/research`), CORS for :4200 only, prompt rule 6 (returns from
   get_market_stats), eval run 3 9/10.
6. Real market data. **6a done (2026-10-12)** on branch `step-6-live-data` (not merged): no live provider (Twelve
   Data's free plan has no bid/ask, ~1 price per 5-7 min on 800 credits/day, XAU/USD only on paid plans, and
   personal, non-display, non-commercial terms); price age/source checks, feed status, no feed by default
   (`MARKET_FEED`), SIMULATED/STALE terminal states, historical-table protection tests, and an events-only
   calendar with exact UTC times: FOMC (expected 14:00 New York) and ECB (14:15 Frankfurt) from official sources,
   all other events via Forex Factory (owner exception, portfolio use only); direct BLS access is blocked (HTTP 403,
   2026-11-06, docs/OVERNIGHT-QUESTIONS.md #5).
   Write-up: `docs/phase-summaries/step-6a-price-safety-calendar.md`.
   **6b-1 done (2026-11-10)**: the bar replay backend (replay-service, see the replay rules). Write-up:
   `docs/phase-summaries/step-6b-1-replay-backend.md`. **6b-2 done (2026-11-10)** on branch
   `step-6b-2-replay-frontend`: the Replay page. Write-up: `docs/phase-summaries/step-6b-2-replay-frontend.md`.
   Future replay items: `docs/BACKLOG.md`.
   A licensed live provider needs bid/ask and display rights; before enabling it, follow the mixed-candles rule.
   Live `candles_4h` and `candles_1d` are UTC-aligned while the historical H4/D1 are New York-close aligned;
   realign the live views to the NY close when a live provider is added.
7. Deployment: one EC2 t3.medium (ap-south-1), Docker Compose, Caddy (HTTPS, one origin), images in ECR, backtest
   results in S3 with the instance role. **Phase 1 done (2026-11-10)**: everything deployable and run locally
   (`docs/DEPLOY.md`). **Phase 2**: the AWS side (instance, IMDSv2 hop limit 2, role policy, ECR, DNS, swap).
   Re-check Dukascopy's terms of use before a public deployment serves its historical data.
   Still open (docs/BACKLOG.md): per-service DB logins for the Node services (market-service first), a non-free
   LLM tier for real research traffic, a single replay instance only, no production metrics or alerting.
8. Known gaps: `forex.calendar-events` has no consumer (and its producer has never fired). The calendar covers USD (FOMC) and EUR (ECB) policy meetings
   from official sources; everything else comes from Forex Factory, a third party approved for portfolio use only (no
   direct BLS: HTTP 403). No forecasts or actuals.

## How to work with me
- This is a portfolio and client project. Keep it production quality, with no shortcuts or simplified "demo" code.
- Explain the reasoning behind architectural decisions. I'm strong on backend and a beginner on frontend.
- For any non-trivial task, plan first and wait for my approval. Work in small phases and verify each one (build, test, run) before moving on.
- Diagnose errors from the actual files and logs, not assumptions.
- Don't rewrite working, completed modules unless the task requires it. Prefer adding new files.
- At the end of each phase, give a summary: what changed, errors hit with root cause and fix, key decisions, commands used, and interview Q&A.
- **No synthetic data, ever.** Historical data must be real market data (Dukascopy).
  Never generate, interpolate, or fabricate prices to make a test or backtest pass.
  The simulated feed (`MARKET_FEED=mock`) is for development only and is always labelled SIMULATED; the default is
  no feed.

## Verification policy (keep it fast)
- While working on a change: run only the affected project's tests, and a single test file
  where possible (`npx nx test order-service --testFile=x.spec.ts`).
- Before each commit: `npx nx affected -t lint typecheck test build --parallel=2`
  (cache ON, daemon ON). Never use `--skip-nx-cache` or `NX_DAEMON=false` unless debugging a cache problem.
- Full clean matrix (`nx reset`, delete dist/, run everything): only at the end of a roadmap step.
- Start services or the browser only when the change affects runtime behavior or UI,
  and only the services involved.
- Run anything over ~2 minutes in the background and keep working meanwhile.
