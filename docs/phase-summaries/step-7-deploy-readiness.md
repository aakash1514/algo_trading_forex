# Roadmap step 7, phase 1: deploy readiness

**Outcome:** ForexEdge runs as one Docker Compose stack behind Caddy (HTTPS, one origin), configured only
from the environment, with health endpoints, closed registration, token expiry on open sockets, backtest
results on S3 through the instance role, and a verified way to move the 19,187,987-minute history into a
fresh database. The whole production stack ran on the laptop at `https://localhost`: login, terminal,
backtest, replay with an order, all checks pass, 1.98 GB while a replay plays (budget 3.5 GB). Phase 2 is
the AWS side (`docs/DEPLOY.md` §6).

Branch `step-7-deploy-readiness` (2026-11-10), not merged.

## 1. What was built

| Commit | Group | What |
|---|---|---|
| `f909690` | A | `/health/live` + `/health/ready` on all 9 apps; pinned JWT claims (HS256, issuer, audiences) for every signer and verifier; sockets held to their token's expiry, replay `reauth`; proactive refresh with a cross-tab lock; replay fill check; order-service's hard-coded Kafka broker |
| `a3cfb54` | B | Feed status dot from real state; `REGISTRATION_ENABLED` (unset = closed) + demo-user tool; research quota in Redis; same-origin frontend (relative URLs, dev rewrites, standalone build); env-driven CORS and cookie; replay socket path `/api/replay/socket.io` (item 9, moved here) |
| `68d125d` | C | `BacktestResultStore` (MinIO or S3 through the existing minio client), EC2 role credentials over IMDSv2, results returned by ws-gateway instead of a presigned redirect |
| `d16caf8` | D | Node and Python Dockerfiles, Linux locks, cross-platform Python targets, `docker-compose.prod.yml` (+ local MinIO override), Caddyfile, compose rule check; `pg` in every service's generated package.json; research-agent's MCP child gets its DB settings |
| `9a18693` | D fix | Caddy routes in written order (found by the local run) |
| `b8f09a2` | E | History transfer (export/import/check), bootstrap, `prod:smoke`, DEPLOY.md, docs |
| close-out | | `replay:verify` renews its token (found by the final run), this write-up, the equivalence report |

## 2. Findings that changed the plan or the code

| Finding | Evidence | What was done |
|---|---|---|
| Replay entry 1.11942 in the 6b-2 run was **not** a bug | 2022-03-01 09:52 opened bid 1.11939 / ask 1.11942; the order was placed at 09:51 with bid close 1.11942 | Regression test on a real minute with the same coincidence (2022-01-03 09:39 → 09:40) |
| Neither redis-py nor `@aws-sdk/client-s3` has provenance | No PyPI attestation for any redis release; npm integrity hash only | Owner's choice: redis-py by byte diff against tag v8.1.0 (121/121 files identical); S3 through the existing minio client |
| minio's `IamAwsProvider` (8.0.7, latest) can't read EC2 credentials | It reads `AccessKeyID`; the metadata service answers `AccessKeyId` (AWS docs); a test runs AWS's documented response through it | Own `Ec2RoleCredentialProvider` (IMDSv2), tested end to end against local metadata and S3 stand-ins |
| Presigned result URLs can't work with a private bucket behind Caddy | The browser would fetch `minio:9000` or S3 directly | ws-gateway reads `results.json` and returns it after the owner check |
| order-service published `orders.lifecycle` to `localhost:9092` | Hard-coded in `order.service.ts` | `KAFKA_BROKER`; a scan test fails on any hard-coded broker |
| The dev `.env` has `KAFKA_BROKERS`, which no code reads | grep | Not changed (owner's file); dev worked through the `localhost:9092` default |
| Services' generated package.json lacked `pg` | TypeORM loads it dynamically | `import 'pg'` in `@forexedge/database` |
| Nx's pruned lockfile is incomplete | `npm ci` refused it (`content-type@1.0.5` missing) | Completed in the build stage, strict `npm ci` at runtime |
| research-agent's MCP child had no DB login in a container | The SDK passes a child only PATH/HOME…; it read `.env` | Named allowlist forwarded, no other secret |
| The tools crashed without a `.env` | `process.loadEnvFile` throws on a missing file | Loaded only when present |
| The login tools can't prove grants on an empty history | `create-ml-db-user.ts` failed on a fresh DB | Bootstrap guard step: stops until the history is imported |
| `next dev` rewrites dropped the socket paths' trailing slash | "Failed to proxy …/socket.io?EIO=4" | Exact rules for both socket paths, verified with real WebSockets |
| Caddy's `respond` ran before every `reverse_proxy` | `/api/auth/register` answered 404 in the local run | `route { }` block; the smoke run checks every prefix reaches its service |
| The 6b-2 terminal's socket only existed on the Terminal page | `useForexSocket` called by `DashboardClient` | Mounted once in the dashboard layout (the dot needs it on every page) |
| One refresh token per user | An API login ended the browser's session (smoke run) | Script takes its token first; BACKLOG 12 |
| Caddy plan routes missed three prefixes | `/api/positions`, `/api/account` (order), `/api/backtest` (ws-gateway) | Routed; DEPLOY.md §2 |

## 3. Frontend decisions, in plain words

**One address for everything.** The page used to call each service on its own port (`localhost:3000`,
`:3004`, …), which only works on a laptop. Now it calls paths on its own address (`/api/orders`, `/socket.io`).
In production Caddy forwards each path to its service; in development `next dev` does the same with
rewrites. The production build carries no backend address at all, and a check in the Docker build fails if
one appears.

**Keeping the login alive.** The access token lasts 15 minutes. A small timer refreshes it a minute before it
expires. Refresh tokens are single-use, so two tabs refreshing at the same moment would log one out; the
browser's Web Locks let only one tab refresh at a time (the others wait and then use the new cookie).

**Sockets and expiry.** The servers now close a socket when its token expires. The replay page sends each
new token to replay-service (`reauth`), so a playing replay isn't interrupted. The terminal's socket reads
the current token whenever it reconnects. If a refresh fails (the session is really over), the app goes to
the login page with "Session expired, please log in" and stops trying.

**The status dot.** ws-gateway knows the configured feed and the last tick it relayed; it sends that every
5 s. The dot is green only for a real feed with a real recent tick; otherwise "Mock feed", "Feed stale",
"No live feed" or "Disconnected". Because the dot is in the top bar, the terminal socket now lives in the
shared page layout instead of the Terminal page.

**Registration.** The page asks the server whether sign-up is open, so one build works for an open
development setup and a closed production.

## 4. Verification

**Per group:** `nx affected -t lint typecheck test build` green before each commit; DB suites for the touched
services: replay-service 153/153 (A and B), order-service 216/216 (A), auth-service with the demo-user and
bootstrap DB tests, ws-gateway 110/110 (C, with a real MinIO round trip), market-data-import transfer 6/6.

**Planted faults** (each made a test fail, then restored): BUY filled at the bid; reauth without the
same-user check; verifier without issuer/audience (TS and Python); ws-gateway without `authExpired`; refresh
without the cross-tab lock; socket renewal loop guard removed; no reauth on token change; registration guard
always open; mock feed shown green; quota not spent; provider reading `AccessKeyID`; a hard-coded broker;
a Linux lock hash changed; a published DB port / missing healthcheck / Bull Board user in compose; a
localhost address in the frontend build; one changed price after an import.

**Live checks:** WebSockets through `next dev` rewrites for both gateways; every image runs non-root and
can't modify its code; the history transfer and both independent data checks on the imported copy; the
production stack (`docs/validation/prod-local-run.md`, all checks pass).

**Clean matrix:** `nx reset`, `dist/` deleted, `npx nx run-many -t lint typecheck test build --parallel=2`:
**all 21 projects pass** (623 s). Jest 953 passed, 103 skipped (the DB-gated suites); pytest research-agent 183
passed / 81 skipped, ml-service 60 / 30; ESLint 0 errors.

**replay:verify:** `npm run replay:verify -- --pairs EUR_USD,XAU_USD,USD_JPY` (`docs/validation/replay-equivalence.md`):
EUR/USD 257/257 (−272.20 USD), XAU/USD 217/217 (−555.92), USD/JPY 215/215 (+1,485.75): every trade, total and
final balance match, as in 6b-1/6b-2. The first attempt stopped at 15 minutes: the tool used one access token
for the whole run, and replay-service now closes a socket at its token's expiry (this step's feature). The tool
now logs in again every 10 minutes, sends the token as `reauth` and fails on a missing acknowledgement within
30 s instead of hanging. Throwaway users deleted afterwards (2 users, 6 sessions, 1,358 positions).

## 5. Commands

```sh
npm run data:transfer -- export            # dev history -> data/history-transfer
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.local.yml --env-file infra/.env.local-prod up -d
docker compose ... --profile ops run --rm ops npx ts-node --transpile-only tools/ops/bootstrap-prod.ts
docker compose ... --profile ops run --rm ops npm run data:transfer -- import --dir /repo/data/history-transfer
node infra/check-compose.mjs
npm run prod:smoke                         # VERIFY_EMAIL / VERIFY_PASSWORD, NODE_OPTIONS=--dns-result-order=ipv4first
```

## 6. Interview Q&A

**How do you stop a WebSocket outliving its token?** The server reads the token's `exp` at the handshake
and sets one timer per socket. At expiry it emits `authExpired` and disconnects. The replay page refreshes a
minute early and sends the new token as `reauth`; the server verifies it with the same algorithm, issuer and
audience as the REST guard and requires the same user before moving the deadline.

**Why pin issuer and audience when the secrets differ?** Defence in depth: a refresh token is never accepted
as an access token even if someone sets both secrets equal, and every verifier (Node REST, both sockets,
two Python services) uses one set of constants, tested across languages.

**Why stream backtest results through ws-gateway instead of presigned URLs?** The bucket stays private, needs
no CORS, the owner check is the same code as every other read, and it works whether storage is S3 or an
internal MinIO.

**How do you know the production database has the same history?** The export writes, per pair, the row
count, the first and last minute and the exact sum of every price and volume column, computed by the source
database; the import recomputes them on the target and must match exactly. Then the importer's own checks
(rows per pair-year against the import log, every aggregate against M1) and the FRED/gold validation run on
the copy.

**What did the local production run catch?** A Caddy rule that turned every API call into a 404 (directive
ordering), the IPv6 reset in Chromium, and that one user can only hold one refresh token.

## 7. PR text

````md
## Step 7, phase 1: deploy readiness

ForexEdge as one Docker Compose stack behind Caddy (HTTPS, one origin), configured only from the
environment. The whole production stack ran locally at https://localhost: login, terminal, backtest,
replay with an order, all checks pass, 1.98 GB while a replay plays (budget 3.5 GB). The AWS side is phase 2.

### What's in it
- **Health:** `/health/live` and `/health/ready` on all 9 apps (DB/Redis/Kafka/bucket/models, 2 s each,
  names only), outside `/api`, not routed by Caddy.
- **Tokens:** every JWT pinned to HS256 + issuer + audience (refresh tokens have their own); sockets closed at
  token expiry, replay `reauth` for the same user; refresh a minute early, one refresh at a time across tabs;
  "Session expired, please log in" instead of a reconnect loop.
- **App settings:** status dot from real feed state (green only for a real recent tick);
  `REGISTRATION_ENABLED` (unset = closed) and an env-only demo-user tool; research quota per user per day in
  Redis (redis-py accepted by byte diff); same-origin frontend (no localhost in the build, checked); CORS and
  the refresh cookie from env, required in production.
- **Storage:** backtest results on S3 with the EC2 instance role (own IMDSv2 provider: minio's reads the wrong
  field) or MinIO locally; results returned by ws-gateway, the bucket stays private.
- **Containers:** Node and Python images (non-root, code read-only, hash-checked Linux locks, CPU torch),
  `docker-compose.prod.yml` (only Caddy publishes ports, limits, healthchecks, restart, log rotation, rules
  checked by `infra/check-compose.mjs`), Caddyfile with every real route prefix.
- **Data:** history export/import/check (19,187,987 minutes, sha256 + per-pair sums, identical after import,
  importer checks and FRED/gold validation pass on the copy); idempotent production bootstrap.
- **Fixes found on the way:** order-service's hard-coded Kafka broker, `pg` missing from generated
  package.json, research-agent's MCP child without DB settings in a container, Caddy rule order, the replay
  socket path under `/api/replay`.

### Checks
- Clean matrix: all 21 projects pass lint, typecheck, test, build (Jest 953, pytest 183 + 60)
- DB suites of touched services; planted faults for every new check
- `replay:verify`: EUR/USD 257/257, XAU/USD 217/217, USD/JPY 215/215, all match to the cent
- `npm run prod:smoke` on the production stack: all checks pass (`docs/validation/prod-local-run.md`)

### Not in this PR
AWS provisioning (phase 2), per-service DB logins for the Node services, production metrics/alerting, several
sessions per user (`docs/BACKLOG.md`). Runbook: `docs/DEPLOY.md`.
````
