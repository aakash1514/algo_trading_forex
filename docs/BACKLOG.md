# Backlog

Known follow-ups that are deliberately not built yet. Each item says why it waits; the roadmap in `CLAUDE.md`
says when.

## Replay (steps 6b-1 and 6b-2)

Done on branch `replay-improvements`: keyboard shortcuts (2026-11-20, was item 1); calendar events on the replay
chart, paged closed-trade history and replay statistics (2026-11-23, were items 2-4; plans in `docs/plans/`).
Done on branch `replay-sessions` (2026-11-24): "My replays" (several sessions per user, one playing, titles,
switching, read-only ended sessions; `docs/plans/replay-sessions.md`). **Resolved: ended sessions are kept
forever** — on purpose (their trades and statistics stay reviewable); the user can now delete an ENDED session with
its trades.

2. **Calendar history before 2021.** The replay chart marks only the events `economic_events` holds: inside the
   replay history (2010-2022) that is the FOMC decisions of 2021-2022 (the Fed's calendar page starts in 2021; ECB
   rows start in 2026-12). Earlier periods say "No calendar data for this period". More needs a licensed historical
   calendar source; nothing may be backfilled by hand.
5. **No stop-out in replay.** As in the backtester, equity can fall below the margin in use. A stop-out rule would
   break the verified equivalence with the backtester, so it needs its own verification.
13. **Replay ack types (StepResult) are duplicated in frontend replay.types.ts; move to a shared lib so a server-side
    shape change breaks the build.** Today `StepResult` (replay-service `playback.service.ts`) and `CommandAck`
    (`replay.gateway.ts`) are copied by hand into `apps/frontend/src/types/replay.types.ts`; the frontend tests type
    their acks against the copy, so a change on the server side alone compiles and passes.
14. **Custom indicators in a Pine-like scripting language** (own interpreter, no `eval`). A small, sandboxed
    language evaluated over the replay's bars up to the clock only (never a later bar), with its own parser and
    interpreter: no `eval`, `Function` or dynamic imports, bounded loops and time. Indicator rows would belong to a
    session and be deleted with it (`REPLAY_SESSION_CHILD_TABLES`).
15. **Flaky under parallel load: `apps/replay-service/src/guarantees/lifecycle.db.spec.ts`, "an expiring token
    without a reauth: authExpired, disconnected, a playing replay paused as DISCONNECT".** It signs a token that
    expires in 2-3 s, then creates, connects, sets the speed, plays and waits for one bar. With every DB suite running
    in parallel on the laptop, the token can expire before the first bar ("no bar within 5000 ms", seen once on
    2026-11-23; passes alone). Fix: issue the short token after the first bar (reauth with it), or give the step its
    own deadline, so the expiry is measured from a known point instead of from the start of the test.

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
