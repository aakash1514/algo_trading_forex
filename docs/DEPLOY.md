# Deploying ForexEdge

One host runs everything with Docker Compose: the nine apps, TimescaleDB, Redis, Kafka and Caddy in front
(HTTPS, one origin). Target: an EC2 t3.medium (2 vCPU, 4 GB RAM + 4 GB swap, x86_64, Ubuntu 24.04) in
ap-south-1, images in ECR, backtest results in S3 with the instance's IAM role. No setting is in the code
or the images: everything comes from `infra/.env.prod` and the domain from `DOMAIN`.

| File | What |
|---|---|
| `infra/docker-compose.prod.yml` | The stack. Only Caddy publishes ports (80, 443) |
| `infra/docker-compose.local.yml` | Laptop only: adds MinIO for backtest results (no instance role on a laptop) |
| `infra/docker/node.Dockerfile` | The six NestJS services, the frontend and the `ops` tools image, from one build |
| `infra/docker/python.Dockerfile` | ml-service and research-agent, from their Linux locks |
| `infra/caddy/Caddyfile` | HTTPS for `DOMAIN`, `www.` → apex, the routes below |
| `infra/check-compose.mjs` | Enforces the compose rules (ports, limits, healthchecks, restart, logs) |
| `tools/ops/bootstrap-prod.ts` | Migrations, instruments, the DB logins, demo users |
| `npm run data:transfer` | The history: export (dev), import (prod), check |
| `npm run prod:smoke` | The deployed stack in a browser, over HTTPS, plus memory |

## 1. Settings (`infra/.env.prod`, never committed)

Every variable is documented in `.env.example`. Production needs:

| Variable | Notes |
|---|---|
| `DOMAIN` | The site's domain. Caddy gets its certificate and redirects `www.DOMAIN`; `CORS_ORIGIN` = `https://DOMAIN` |
| `IMAGE_REGISTRY`, `IMAGE_TAG` | ECR repository prefix and the tag (a git commit) |
| `DB_NAME`, `DB_USER`, `DB_PASS` | The main login (owner of the tables; migrations, the history import) |
| `ML_DB_USER/_PASS`, `RESEARCH_DB_USER/_PASS`, `REPLAY_DB_USER/_PASS` | The restricted logins; passwords ≥ 16 characters |
| `REDIS_PASS` | |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Long random strings, different from each other |
| `STORAGE=s3`, `AWS_REGION`, `S3_BUCKET` | Backtest results; credentials from the instance role (never keys) |
| `GROQ_API_KEY` | research-agent's LLM (free tier) |
| Optional | `MARKET_FEED` (default `none`), `REGISTRATION_ENABLED` (default `false`), `COOKIE_SECURE` (default `true`), `RESEARCH_DAILY_LIMIT` (20), `FEED_LIVE_MAX_AGE_S` (10), `JWT_*_EXPIRES` |

Demo users go in `infra/.env.demo-users` (also ignored by git): `DEMO_USERS=demo` in `.env.prod`, then
`DEMO_DEMO_EMAIL=...` and `DEMO_DEMO_PASS=...` (≥ 12 characters, the sign-up rules). Nothing logs them.

The compose file refuses to start when a required variable is missing (`${VAR:?}`), and with
`NODE_ENV=production` (set by the compose file) a service refuses to start without `CORS_ORIGIN` or
(ws-gateway) `STORAGE`.

## 2. Routes (Caddyfile)

Checked against the controllers: every prefix below reaches its service, and `npm run prod:smoke` checks
each one through Caddy.

| Path | Service |
|---|---|
| `/api/auth*` | auth-service :3000 |
| `/api/market*` | market-service :3002 |
| `/api/domain*` | domain-service :3003 |
| `/api/orders*`, `/api/positions*`, `/api/account*` | order-service :3004 (the step-7 plan listed only `/api/orders`) |
| `/api/backtest*`, `/socket.io/*` | ws-gateway :3005 (the plan listed only the socket) |
| `/api/ml*` | ml-service :3006 |
| `/api/research*` | research-agent :3007 (110 s response timeout for `/ask`) |
| `/api/replay*` (REST and the socket path `/api/replay/socket.io`) | replay-service :3008 |
| `/health*`, `/admin*`, any other `/api/*` | 404 at Caddy |
| everything else (`/replay` page included) | frontend :3000 |

## 3. Health checks

Every app answers `GET /health/live` (the process is up) and `GET /health/ready` (its own dependencies:
DB, Redis, Kafka, the results bucket, ml-service's models), outside the `/api` prefix, without auth, with
the dependency names only (503 when one is down). Caddy doesn't route them: Docker's healthchecks call
`/health/live` inside each container. **The deploy check runs `/health/ready` the same way:**

```sh
C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod"
for sp in auth-service:3000 market-service:3002 domain-service:3003 order-service:3004 ws-gateway:3005 \
          replay-service:3008 frontend:3000; do
  $C exec -T ${sp%%:*} node -e "fetch('http://127.0.0.1:${sp##*:}/health/ready').then(async r=>{console.log('${sp%%:*}',r.status,await r.text());process.exit(r.ok?0:1)})"
done
for sp in ml-service:3006 research-agent:3007; do
  $C exec -T ${sp%%:*} python -c "import urllib.request as u; r=u.urlopen('http://127.0.0.1:${sp##*:}/health/ready'); print('${sp%%:*}', r.status, r.read().decode())"
done
```

## 4. A fresh database: bootstrap and the history

```sh
C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod"
$C up -d timescaledb redis kafka
$C --profile ops run --rm ops npx ts-node --transpile-only tools/ops/bootstrap-prod.ts   # stops at "history loaded"
$C --profile ops run --rm ops npm run data:transfer -- import --dir /repo/data/history-transfer
$C --profile ops run --rm ops npm run data:import -- --check-only   # rows per pair-year, aggregates vs M1
$C --profile ops run --rm ops npm run data:validate                 # FRED fixings, gold extremes
$C --profile ops run --rm ops npx ts-node --transpile-only tools/ops/bootstrap-prod.ts   # every step now
$C up -d
```

The bootstrap runs, in order: migrations, the instruments seed, a check that the history is loaded, the ML,
research and replay logins, the demo users. Every step is idempotent (a second run changes nothing; tested
twice on `<DB_NAME>_test`). It stops before the logins until the history is in, because each login tool
proves its grants by reading EUR/USD H1 bars, and an empty read would prove nothing.

The history comes from the dev database: `npm run data:transfer -- export` writes
`data/history-transfer/` (4 gzip CSVs of `historical_candles`, one per pair, the import log, and
`manifest.json` with each file's sha256 and, per pair, the row count, first/last minute and the sum of
every value column). Copy that directory to the host (`data/history-transfer` next to `infra/`); the
`ops` container mounts it. The import refuses a missing or altered file and a target that already holds
history, then COPYs, compresses, refreshes the aggregates (5m → 15m → 1h per year, 4h → 1d over one padded
window) and compares the result with the manifest. `check` can be run any time and fails on an empty or
partial import.

**Laptop run (2026-11-10):** export 145 s, 423 MB; import 677 s, identical to the export (19,187,987
minutes); `--check-only` all checks pass (159/159 chunks compressed, 2,700.9 MB → 361.5 MB, database
558.8 MB); `data:validate` all checks pass.

## 5. Local production run (item 13)

```sh
# infra/.env.local-prod: DOMAIN=localhost and random secrets; infra/.env.demo-users: the demo login
C="docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.local.yml --env-file infra/.env.local-prod"
$C --profile ops build && $C up -d          # then section 4 for a fresh database
node infra/check-compose.mjs infra/docker-compose.prod.yml infra/docker-compose.local.yml
set -a; . infra/.env.demo-users; set +a
NODE_OPTIONS=--dns-result-order=ipv4first VERIFY_EMAIL="$DEMO_DEMO_EMAIL" VERIFY_PASSWORD="$DEMO_DEMO_PASS" npm run prod:smoke
```

Caddy serves `https://localhost` with its own local CA (accepted by the smoke run for `localhost` only).
On Windows, Docker Desktop resets IPv6 connections to published ports, hence `ipv4first` (and the smoke
run maps `localhost` to 127.0.0.1 in Chromium).

**Result (`docs/validation/prod-local-run.md`, all checks pass):** HTTP → HTTPS, `www` → apex, every prefix
reaches its service, both Socket.IO paths answer, `/health*`, `/admin*` and unknown `/api` paths 404;
sign-up 403, no Register link, the demo user logs in, the terminal dot says "No live feed"; a backtest
(MA crossover, EUR/USD H1, January 2022) completes and its `results.json` (15 trades) comes back through
Caddy from the store; a replay plays over `/api/replay/socket.io`, a BUY placed at 09:52 (bid 1.11962 /
ask 1.11965 at that minute's close) fills at 09:53's ask open, 1.11963.

**Memory (`docker stats`, MB):**

| Container | Idle | Replay playing | Limit |
|---|---|---|---|
| timescaledb | 435 | 445 | 1024 |
| kafka | 489 | 579 | 800 |
| ml-service | 189 | 189 | 640 |
| minio (laptop only) | 144 | 146 | 256 |
| research-agent | 101 | 101 | 480 |
| ws-gateway | 80 | 81 | 320 |
| domain-service | 75 | 76 | 192 |
| order-service | 74 | 74 | 224 |
| replay-service | 65 | 66 | 288 |
| market-service | 63 | 63 | 192 |
| auth-service | 60 | 61 | 192 |
| frontend | 53 | 54 | 192 |
| caddy | 25 | 33 | 64 |
| redis | 11 | 11 | 160 |
| **Total** | **1,863** | **1,979** | 5,024 |

1.98 GB of the 3.5 GB budget while a replay plays (1.83 GB without MinIO, as in production); Kafka's JVM is
the one that moves (489 → 579 MB of its 800). Redis `used_memory` 2.12 MB (maxmemory 96 MB). A second run gave
1.83 / 1.87 GB. The limits add up to more than the host on purpose: they are
ceilings per container, and swap covers peaks.

Images on disk: NestJS services 450–485 MB, frontend 425 MB, research-agent 376 MB, ml-service 1.71 GB
(CPU torch), ops 2.26 GB (all dev dependencies; run once, never a service).

## 6. Phase 2 (AWS) notes

- **IMDSv2 hop limit 2.** Containers reach the instance metadata one hop further than the host; with the
  default limit of 1 the S3 credential request times out:
  `aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-put-response-hop-limit 2`.
- **Instance role policy:** `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::<bucket>/*`, `s3:ListBucket` on
  the bucket (startup and readiness check that it exists); ECR pull. The bucket is private and needs no CORS
  (the browser never talks to it: ws-gateway returns `results.json` itself).
- **Credentials:** ws-gateway reads them from instance metadata (`ec2-role-credentials.ts`). minio's own
  `IamAwsProvider` (8.0.7) reads the field `AccessKeyID` while the metadata service answers `AccessKeyId`,
  so it isn't used.
- **Security group:** 80 and 443 only (22 from your IP if you use SSH; SSM needs none).
- **DNS:** `DOMAIN` and `www.DOMAIN` → the instance's Elastic IP before the first `up` (Let's Encrypt).
- **Swap:** 4 GB swap file on the host.
- **Before a public deployment:** re-check Dukascopy's terms for serving its historical data (roadmap step 7),
  and the Forex Factory exception (portfolio use only).
