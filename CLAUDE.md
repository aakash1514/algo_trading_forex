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
| ws-gateway | 3005 | Socket.IO gateway (rooms `user:<id>`, events `tick:<instrument>`). Relays `forex.ticks`, `orders.lifecycle`, `positions.updated` to clients. Also hosts the **backtest engine**: a BullMQ queue/worker with strategies in `backtest/strategies/` registered via `strategy.registry.ts`, results stored in MinIO, and Bull Board at `/admin/queues`. |

Nothing produces `positions.updated` yet. ws-gateway subscribes to it, but order-service doesn't publish it.

### Kafka flow
```
market-service ─forex.ticks─▶ market-service (DB/cache writers), domain-service (spread monitor), order-service, ws-gateway
domain-service ─forex.sessions / forex.spread-alerts─▶ order-service
domain-service ─forex.calendar-events─▶ (no consumer yet)
order-service  ─orders.lifecycle─▶ ws-gateway ─socket.io─▶ frontend
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
- State uses Redux Toolkit. RTK Query APIs in `src/store/api/*.api.ts` all extend `baseApi`, which attaches the bearer token from the store or `localStorage` (`fx_access_token`). On a 401 it calls `auth/refresh` and retries.
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
- In order-service, `req.user.id` (NOT `userId`). JwtStrategy returns `{ id: payload.sub, email, role }`.
- TypeORM: entities are direct class references (no globs) and use `!` definite assignment. Nullable union columns need explicit `type: 'varchar'`. Webpack must keep `optimization.minimize: false`, or entity class names break.
- Never store derived columns. `account_summary` stores only balance, margin_used and unrealized_pnl. Equity, free margin and margin level are computed on read.
- Tick/time-series tables use raw SQL migrations, never ORM sync on hypertables.
- After a DB reset, refresh the TimescaleDB continuous aggregates bottom-up (1m → 5m → … ) with `CALL refresh_continuous_aggregate(...)`.
- Order FSM transitions are synchronous DB transactions. Kafka publish happens only after commit.
- KafkaJS needs `Partitioners.LegacyPartitioner` and `KAFKAJS_NO_PARTITIONER_WARNING=1`. Topics are ensured before the producer connects (KRaft cold start).
- ws-gateway bootstrap order: register Bull Board middleware BEFORE the Socket.io adapter. Socket.io CORS lives in the custom `SocketIoAdapter`, not `enableCors()`.
- Frontend: Tailwind **v3** (not v4). lightweight-charts v5 uses `addSeries(CandlestickSeries, opts)`. Use `createSelector` for derived Redux arrays.
- Backtest results come back as **flat fields** on the run object (no nested `metrics` key).
- Pip size: the source of truth is `instruments.pip_size` (0.01 for JPY-quoted pairs, else 0.0001).
  The frontend uses `apps/frontend/src/lib/pip.ts`, never a hardcoded `* 10000`. Candles are built from **mid**.

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

## Current status
- Phases 1–6 (5 services + frontend: trading terminal, backtesting, economic calendar) were built by ~June 2026 and **haven't been run since**, so verify before assuming anything works.
- Never deployed. Earlier attempts hit many issues.
- Health check (2026-10-09): infra is healthy. From a clean `dist/`, all 9 projects pass build,
  typecheck, lint (0 errors) and tests, and all 5 compiled services boot from the repo root.

### Deferred from the health check
- `npm audit`: 88 vulnerabilities (7 critical). Don't run `npm audit fix --force`; review upgrades deliberately.
- `minio/minio` is no longer anonymously pullable (see step 7). The pinned release only runs where the
  image is cached; a `docker save` backup lives outside the repo.
- XAU/USD and order-service's hardcoded JPY pip rule are scheduled in step 2.
- Lint warnings remain (mostly `no-explicit-any` and unused vars): 16 in the frontend, more in the services.
- ws-gateway has no tests (`passWithNoTests`); backtest tests come in step 3. Redis still holds stale
  BullMQ `bull:backtest:*` jobs from earlier runs.

## Roadmap (in order)
1. Health check: infra up, all projects build and serve, fix breakages.
2. Historical data seed: M1 OHLC candles, 2010–2022, imported from Dukascopy via the dukascopy-node package (UTC timestamps) for
   8 pairs: EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD, XAU/USD.
   M1 goes into its own hypertable with compression. M5/M15/H1/H4/D1 are continuous
   aggregates on it. The import script must be idempotent (safe to re-run). The market-service
   candle queries and the ws-gateway backtester read from it. Production deploys only H1 and above.
   XAU/USD integration: add it to the instruments seed with the correct contract specs (100 oz lot, pip 0.01).
   Replace order-service's 3 hardcoded pip-size calculations with instruments.pip_size from the DB.
   Add XAU_USD to MAJOR_PAIRS, PAIR_DISPLAY and BacktestClient's pair list, and remove EUR_GBP there.
   Verify pip value, margin and P&L for gold with tests.
3. Backtest verification: re-run strategies on the historical data. The all-zero
   metrics were caused by mock random-walk data. Confirm they're fixed and fix anything remaining.
4. Python ML service: LSTM price prediction (trained on the seeded history) + FinBERT sentiment.
5. Research agent: Python/FastAPI + LangGraph + MCP, forex news and economic analysis per pair.
6. Real market data: Twelve Data API behind `USE_MOCK_DATA` (OANDA unavailable in India).
7. Deployment (no credit card): Vercel, Aiven (TimescaleDB + Valkey), Cloudflare R2, free-tier service host.
   Refresh-token cookie needs `secure: true` and `sameSite: 'none'` for cross-origin (Vercel → backend); make it env-driven.
   MinIO community images are no longer pullable. Replace local MinIO with an R2 dev bucket or another S3-compatible image.
8. Known gaps: nothing publishes `positions.updated`, and `forex.calendar-events` has no consumer.

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