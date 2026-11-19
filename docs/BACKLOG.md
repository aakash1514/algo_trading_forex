# Backlog

Known follow-ups that are deliberately not built yet. Each item says why it waits; the roadmap in `CLAUDE.md`
says when.

## Replay (steps 6b-1 and 6b-2)

Done on branch `replay-improvements` (2026-11-20): keyboard shortcuts on the Replay page (Space, →, Shift+→
for 10 bars, ↑/↓ speed, B/S preselect the order side without placing an order, ? help, Esc). It was item 1.

2. **Calendar events on the replay chart.** Needs historical calendar data for 2010–2022, which ForexEdge doesn't
   have (the calendar holds upcoming events only, from FOMC, ECB and Forex Factory).
3. **Detailed replay statistics.** Win rate, drawdown, average trade and so on. The end-of-session summary has the
   balance change, net P&L and the number of trades only.
4. **Paged closed-trade history.** The socket's state carries only the last 50 closed or cancelled entries, so the
   page lists those, and the end summary marks the trade count "+" when the state was at that cap. Needs a paginated
   trades endpoint on replay-service.
5. **No stop-out in replay.** As in the backtester, equity can fall below the margin in use. A stop-out rule would
   break the verified equivalence with the backtester, so it needs its own verification.

## Deployment (step 7)

Done in step 7 phase 1: JWT expiry on open sockets (both gateways hold a socket to its token's expiry;
replay-service takes a `reauth`), and `/health/live` + `/health/ready` on every app.

6. **Per-service database logins for the Node services.** auth, market, domain, order and ws-gateway still
   connect as the main DB user (the tables' owner). Each should get its own login with only its grants, like
   replay, ML and research; market-service first (INSERT on `ticks` only), so the database itself refuses a
   write to `historical_*` (today tests enforce it).
7. **Images are not minimal.** Node services ~450 MB on disk (the `node:24-bookworm-slim` base is ~340 MB;
   Alpine would need argon2's musl build verified), ml-service 1.7 GB (CPU torch, numpy, scipy). Fine for
   one host; worth trimming before a registry bill matters.
8. **Single host, single replay instance.** Timers and the session lock are in-process (see the 6b-1
   write-up); a second replay-service needs a DB-level lock and timer ownership.
9. **No alerting or metrics in production.** Prometheus/Grafana stay local; the host has Docker
   healthchecks and `restart: unless-stopped` only.
10. **Dev tools that touch MinIO directly** (`tools/ops/delete-verification-users.ts`,
    `purge-pip-backtest-runs.ts`) work with STORAGE=minio only; they would need the result store to clean
    up S3.
11. **Old `localhost`-port workflows.** The production frontend alone (`nx run frontend:serve:production`)
    calls the APIs on its own origin, so `npm run replay:browser` now needs Caddy in front (the production
    compose, or a local Caddy); `npm run prod:smoke` replaces it for the deployed stack.
12. **One refresh token per user.** auth-service keeps a single `refresh:<userId>` in Redis, so a login on
    another device (or an API login) replaces it, and the first browser's session ends at its next refresh
    or page load (found by `npm run prod:smoke`). Tabs of one browser are fine (they share the cookie, and
    step 7 serialises their refreshes). Several sessions per user need a token family per device.

research-agent: report 1d/4h bars by trading date (NY 17:00 close), not the bar’s UTC open time (e.g. the 2020 gold high is the 2020-08-07 session, reported as 2020-08-06).

Data licensing: Dukascopy display terms unclear — demo logins only, no public link, until clarified.
