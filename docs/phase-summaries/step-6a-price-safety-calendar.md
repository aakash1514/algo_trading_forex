# Roadmap step 6a: price safety and an official economic calendar

**Outcome:** ForexEdge no longer shows or trades on prices it can't stand behind.
- **No feed by default.** market-service starts no stream unless `MARKET_FEED` names one. The terminal says "No live
  market feed — historical Replay mode is coming", and order-service rejects every order with "No live price".
- **Simulated prices only on request, and labelled.** The random simulator runs only with `MARKET_FEED=mock`, and every
  place it shows says "SIMULATED PRICES — not market data".
- **Every traded price is checked.** order-service checks each price's source and age, so a stale, missing or
  wrongly sourced price never fills an order or triggers an exit.
- **The history is protected.** Live ticks provably can't reach the imported history.
- **An official, events-only calendar.** The economic calendar comes from the Federal Reserve's FOMC calendar and the
  ECB's meeting schedule, and the third-party weekly feed is gone.

There is no live price provider. Twelve Data's free plan doesn't fit (§2). Branch `step-6-live-data` (2026-10-12),
not merged.

## 1. What was built

| Commit | What |
|---|---|
| `18449b5` | Price age and source checks (order-service `PriceFeedPolicy`, libs/common `market-feed.ts`) |
| `8799173` | `MARKET_FEED` (none/mock), feed status with backoff, no fallback, no feed by default |
| `654def3` | Tests proving live ticks never reach `historical_*` (DB + static) |
| `b2af2fd` | Terminal states: no feed, SIMULATED, STALE; order entry gated |
| `9380251` | Events-only calendar from the FOMC and ECB official calendars |
| `9278a9e` | The third-party weekly calendar fetcher removed, its 20 rows deleted, grep test |
| close-out | Offline guard for domain-service tests, docs, clean matrix (this commit) |

## 2. Why no live provider: the Twelve Data research

Checked 2026-10-12 on twelvedata.com (pricing, docs, terms, support articles):

**Data**
- **No bid/ask.** `/price` returns one `price`; `/quote` returns OHLC, volume and change fields, with no bid or ask. No
  forex endpoint returns bid/ask.
- **Free plan quota.** The Basic plan gives "8 API (800 a day)" credits, at 1 credit per symbol. For 4 pairs that's 200
  polls a day, about one price every 7.2 minutes (5.4 minutes for 3 pairs). WebSocket is a trial on Basic; full access
  starts at Pro.
- **XAU/USD is on paid plans only.** Twelve Data lists it under commodities (`/commodities` → "Gold Spot"), which start
  at the paid Grow plan.

**Terms**
- **Personal use only.** The individual plans are "for personal, internal, and non-commercial purposes".
- **Non-display.** Basic includes only "Internal non-display usage"; "Internal display" starts at Grow.
- **Commercial use and redistribution.** §2.3(l) forbids "Use Free Tier data for commercial purposes". §2.3(b) forbids
  redistribution, and §2.2(e) allows external display only with a redistribution add-on.
- **Retention.** §2.3(g) and §16.2 limit retention ("All Data must be deleted within 30 days"; context not read).

**Conclusion**
- **As a portfolio piece:** showing the prices in a UI is display, which Basic doesn't include.
- **As a client deliverable:** commercial use is forbidden.
- **Prices:** without bid/ask, every fill and spread check would need an invented spread.
- **Decision:** no Twelve Data adapter, and no JForex live feed either.

## 3. Price safety

**Config: `MARKET_FEED`** (libs/common `market-feed.ts`, read by market-service and order-service)
- `none` (the default, also when unset) or `mock`. Any other value fails startup.
- `USE_MOCK_DATA` is no longer read. An old `.env` gets a warning instead of a silently re-enabled simulator.

**order-service** (`PriceFeedPolicy`, provided once by `KafkaConsumerModule`)
- `PricingService.getQuote` rejects a price if:
  - its source isn't one the configured feed trades on (none: nothing; mock: MOCK);
  - it's older than its source's `MAX_PRICE_AGE_MS` (MOCK 2 s, the old Redis key lifetime);
  - its timestamp is invalid or more than 1 s in the future.
- **Rejection reasons:** "No live price for EUR/USD"; "Price for EUR/USD is stale: last quote 7 s old (max 2 s, source
  MOCK)"; "Price for EUR/USD comes from source MOCK, which the configured market feed (none) does not trade on".
- `StalePriceError` extends `PriceUnavailableError`, so stop-out skips stale prices the way it skips missing ones.
- **Tick consumer:** drops untradable ticks before SL/TP and P&L.
  - Behaviour change: a backlog replayed after a restart no longer triggers exits at old prices. A level crossed while
    order-service was down triggers on the next fresh tick, at that tick's price.
  - In the default-config check it skipped 1,932 leftover simulated ticks.

**market-service** (`StreamService`, `createStreamProvider`)
- The simulated provider is built only for `mock` (tested). With `none`, no provider exists and nothing starts.
- **Feed status** at `GET /api/market/feed/status`: `{feed, source, simulated, state, since, lastTickAt, lastError}`.
  - States: off, connected, degraded, down.
  - On a provider error it publishes nothing more (late ticks from the failed connection are ignored), disconnects,
    and reconnects with backoff (1 s doubling to 60 s; down after 3 failures).
  - Prices age out; there is no fallback.
  - `lastError` is the error type only, never a provider message (which could carry a key).

**Terminal** (frontend)
- A banner per feed state.
- Per pair: a SIMULATED badge (source MOCK) and a STALE badge (older than the mirrored maximum age).
- Order entry is disabled with the reason. In mock mode the button reads "Paper trade on simulated prices".

## 4. Live ticks vs the history

- **The only write path.** `insertLiveTick` (libs/database `live-ticks.ts`, into `ticks`) is the only live write
  path; market-service's tick DB writer uses it.
- **DB test** (market-data-import `live-isolation.db.spec.ts`, `RUN_DB_TESTS`):
  - imports a real Dukascopy excerpt (1,425 EUR/USD minutes);
  - fingerprints every `historical_*` relation (row count + content md5);
  - writes real recorded ticks through `insertLiveTick` and refreshes `candles_1m`;
  - asserts the fingerprints are identical and the ticks are in `ticks`.
  - A deliberate delete from `historical_candles` made it fail (checked).
- **Static test** (market-service `historical-isolation.spec.ts`):
  - no INSERT/UPDATE/DELETE/TRUNCATE/COPY/ALTER/DROP of `historical_*` anywhere in market-, order- or domain-service,
    ws-gateway or the shared libs;
  - the importer is detected as a positive control.
- **Deferred to step 7:** a market-service DB login that can write only `ticks`.
- **Hard rule (mixed candles).** The live `candles_*` don't separate sources, and `ticks` holds MOCK ticks. Before any
  live provider is enabled, either delete the MOCK ticks and their candles or add `source` to the live aggregates.

## 5. Economic calendar

**Sources** (`economic-calendar/official-sources.ts`)

| Source | Page | Terms | robots.txt (2026-10-12) |
|---|---|---|---|
| Federal Reserve Board | FOMC meeting calendar | Public domain, "Please cite to the Board as the source" | None (404 page: no rules) |
| ECB | Governing Council meeting schedule | Free use, citing the ECB, with modifications stated | Doesn't disallow `/press/calendars/`; crawl delay 5 s |
| BLS | Release calendar | Public domain | Doesn't disallow it, but the feed answered **403** to our User-Agent: skipped (OVERNIGHT-QUESTIONS #5) |

**Fetching**
- At most once per UTC day per source, through a Redis `SET NX` claim per source and date (kept 48 h) made before
  the request, so restarts and failures don't refetch; the 06:15 UTC cron is each day's first attempt.
- User-Agent: `ForexEdge/0.1 (economic calendar; +https://github.com/aakash1514/algo_trading_forex)`.

**Parsers**
- Strict: they throw `CalendarParseError` on any unexpected markup, an empty list, or no monetary policy meeting (ECB).
- On a fetch or parse failure the stored events are kept and the failure is logged, including Node fetch's hidden
  network error code.
- On success the source's events from today on are replaced, so a cancelled meeting disappears.

**Data**
- **Dates only, so events are all-day.** `economic_events.all_day` is set and the date is stored at 00:00 UTC, so no
  time is invented. The frontend reads those dates in UTC, so they never show as the day before west of UTC.
- **Titles** are the sources' own wording.
- **Forecast, previous and actual** stay null and show as "—".
- **Impact** is a fixed ForexEdge classification (`impact.ts`), labelled in the UI:
  - HIGH: FOMC meetings; ECB monetary policy meetings, Day 2 (the decision).
  - MEDIUM: ECB press conferences listed separately.
  - LOW: everything else.

**UI**
- Each event links to its source.
- A footer cites the Board of Governors of the Federal Reserve System and the ECB.
- A note says GBP and JPY events and US data releases (BLS) aren't available.
- Currency filters are limited to USD and EUR.

**Consumers**
- Gate 5 (order-service, warning only) also warns on all-day events on today's date.
- `forex.calendar-events` (no consumer) is kept; it publishes only timed events.

**Removed**
- The third-party weekly feed's fetcher, its cron, its HTTP client and its comment.
- Migration `RemovePreOfficialCalendarEvents` deleted its rows (logged on the dev DB: "rows without a source 20 -> 0;
  official events kept: 55") and made `source` required.
- A test fails on any reference to that feed in any tracked or untracked file (checked with a deliberate file).

## 6. Errors hit, root cause, fix

- **Nest injection of an optional clock parameter.** Nest would try to inject `now: () => number`. Fix: a factory
  provider for `PriceFeedPolicy`, and no clock parameter on `StreamService` (tests use fake timers).
- **Tests reading `.env` through `ConfigService`.** `new ConfigService({...})` still prefers `process.env`, and Nx loads
  the root `.env` into it, so a test of "no USE_MOCK_DATA" saw the real `.env`'s value. Fix: the feed is passed as a
  value (`PriceFeedPolicy(feed)`, `warnIfLegacyFeedFlag(raw)`); only the factories read config.
- **Cross-project test placement.** Nx module boundaries forbid relative imports between projects, so the DB test
  couldn't import market-service. Fix: the live write moved into `@forexedge/database`, and the DB test lives next to
  the importer.
- **RTK Query cache shared between component tests.** The singleton store served an earlier test's response. Fix:
  `resetApiState()` in `beforeEach`.
- **jsdom tests and timers.** Fake timers were needed for the STALE transition and for fetchBaseQuery's timeout timer.
- **BLS 403.** bls.gov refuses automated requests not meeting its usage policy. Not worked around; logged as a question.
- **Node fetch "fetch failed".** One transient FOMC failure at the first sync, with the cause hidden. Fix: the log now
  includes the underlying code. Not refetched the same day.
- **CRLF in recorded pages.** Git's autocrlf would have changed their bytes. Fix: `-text` in `.gitattributes`; the
  committed blobs' sha256 values match.
- **My mistake: my email in a User-Agent.** While checking robots.txt I put the user's email in the User-Agent of three
  robots.txt requests. The service and all later requests use the repository URL.
- **Jest "worker failed to exit".** Seen for order-service (pre-existing, also in step 5b's matrix) and occasionally for
  ws-gateway and domain-service under parallel load. Both are clean in isolation.

## 7. Results

- **Default config** (current `.env`: no `MARKET_FEED`, an old `USE_MOCK_DATA` line), checked over HTTP with every
  service running in compiled mode:
  - `GET /api/market/feed/status`: `{"feed":"none","source":null,"simulated":false,"state":"off",...}`;
  - a market order as research_demo: `REJECTED | No live price for EUR/USD`;
  - market-service warns that `USE_MOCK_DATA` is no longer read and that no feed runs;
  - order-service skipped 1,932 leftover simulated ticks;
  - `/dashboard` and `/calendar` return 200; the calendar API returns the ECB's 18 HIGH events, all-day.
- **Mock mode** (`MARKET_FEED=mock`): feed status connected, simulated true, ticks published.
- **Clean matrix and opt-in suites:** see §9.

## 8. Commands

```sh
MARKET_FEED=mock npx nx serve market-service      # simulated prices (development only); default: no feed
curl http://localhost:3002/api/market/feed/status
RUN_DB_TESTS=true npx nx test market-data-import --testFile=live-isolation.db.spec.ts --skip-nx-cache
RUN_DB_TESTS=true npx nx test domain-service --skip-nx-cache        # calendar sync into the _test database
npx ts-node --transpile-only tools/ops/record-calendar-fixtures.ts  # opt-in: re-record the official pages
npm run migration:run                                                # EconomicEventSource, RemovePreOfficialCalendarEvents
```

## 9. Close-out

**Clean matrix**
- Steps: `npx nx reset`, `dist/` deleted, then `npx nx run-many -t lint typecheck test build --parallel=2`.
- **All 18 projects pass** (678 s).
- ESLint: 0 errors, 48 warning lines (51 before; the calendar no longer uses `any`). None is on a line step 6a wrote;
  three are pre-existing lines in files it touched.
- Jest: 651 passed (590 before, plus 61 new), 26 skipped.
- pytest: research-agent 150 passed, 80 skipped; ml-service 47 passed. Neither changed in step 6a.
- No "worker failed to exit" warning in this run.
- One change came after the matrix: the calendar's fetch claim became one per UTC day (it was 24 h from the first
  attempt, which could skip the next day's cron). The affected checks after it pass for 15 projects, and the
  domain-service DB suite passes 38/38.

**Offline proof**
- domain-service, the only service here with outbound HTTP, runs its tests with `jest.setup.cjs` replacing `fetch` by
  a function that throws. A test calls the real fetcher and expects that error.
- Market-service has no networked provider (the simulator is local), and the frontend tests mock `fetch` explicitly.
- No Twelve Data key exists anywhere.

**Opt-in suites** (`RUN_DB_TESTS=true`, `--skip-nx-cache`)

| Suite | Result |
|---|---|
| market-data-import (includes the live-isolation test and the migration walk-down) | 67/67 |
| order-service | 204/204 |
| domain-service (includes the calendar sync into the _test database) | 38/38 |

Not rerun: the ml-service and research-agent DB suites (no change in step 6a).

## 10. Interview Q&A

- **Why not use the free Twelve Data plan for live prices?** It returns one price without bid/ask, about every
  5-7 minutes on the free quota. Gold is on paid plans, and the terms allow personal, non-display, non-commercial use
  only. Filling orders would need an invented spread, and showing the prices would breach the terms.
- **What stops a stale price from filling an order?** An explicit age and source check on every quote and every tick,
  with the source's own maximum age, not just a Redis TTL. The reason names the age, the limit and the source.
- **Why no fallback to the simulator when a provider fails?** A silent fallback would put random prices on positions
  that look real. A failing feed publishes nothing; prices age out and orders are rejected with a clear reason.
- **How do you prove live data can't corrupt the backtest history?** There's a single write path, a static scan of all
  service and library code for writes to `historical_*` (with a positive control), and a DB test that fingerprints
  every historical relation around real tick writes. Each was shown to fail on a deliberate violation.
- **How do you build a calendar without inventing data?** Use only official sources whose terms permit reuse, keep
  their wording, store date-only events as all-day instead of guessing times, label the impact classification as
  ours, and keep the last good data when a page changes.

## 11. Keywords

Price staleness, fail-closed order gates, feed health and exponential backoff, no-silent-fallback, data licensing
(display vs non-display, commercial use), robots.txt and crawl etiquette, strict HTML parsing, idempotent upserts,
TimescaleDB continuous aggregates, Nx module boundaries.

## 12. Open items

- **docs/OVERNIGHT-QUESTIONS.md #5:** BLS needs a contact email in the User-Agent (not confirmed officially). Should we
  send one?
- **Replay mode** (step 6b).
- **A licensed live provider** with bid/ask and display rights; before enabling it, follow the mixed-candles rule.
- **The market-service DB login** with INSERT on `ticks` only (step 7).
- **The unreachable OANDA provider file** remains in market-service (not wired to any `MARKET_FEED` value).
- **One REJECTED order row on research_demo**, from the default-config check.

## 13. Pull request

Not opened (as instructed). Compare: https://github.com/aakash1514/algo_trading_forex/compare/main...step-6-live-data?expand=1

**Title:** `Step 6a: price safety, no feed by default, and an official events calendar`

**Description:**

````markdown
## Summary
ForexEdge no longer shows or trades on prices it can't stand behind, and the economic calendar now comes from official central-bank calendars.

**No live provider.** Twelve Data's free plan has no bid/ask and about one price every 5–7 minutes on 800 credits/day. Gold is on paid plans only, and the terms allow personal, non-display, non-commercial use. Research and quotes are in `docs/phase-summaries/step-6a-price-safety-calendar.md` §2.

### Price safety
- **`MARKET_FEED`** (`none` by default, or `mock`) replaces `USE_MOCK_DATA`. With `none`, market-service starts no stream. Any other value fails startup.
- **order-service checks every quote and tick** for its source and age (`MAX_PRICE_AGE_MS`, MOCK 2 s), with clear rejection reasons ("No live price for EUR/USD", "Price for EUR/USD is stale: last quote N s old (max M s, source X)"). Stop-out and SL/TP skip stale prices. A post-restart backlog no longer triggers exits at old prices.
- **Feed status** (`GET /api/market/feed/status`): off, connected, degraded or down, with reconnect backoff. A failing provider publishes nothing and is never replaced by the simulator.

### Terminal
- **No feed:** "No live market feed — historical Replay mode is coming", and order entry is disabled.
- **Mock mode:** "SIMULATED PRICES — not market data", a SIMULATED badge per pair, and the button reads "Paper trade on simulated prices".
- **STALE** badge once a price is older than its maximum age.

### Historical data protection
- **One write path:** live ticks go only to `ticks` through `insertLiveTick`.
- **Tests:** a DB test fingerprints every `historical_*` relation around real tick writes, and a static test scans all service and library code. Both were shown to fail on a deliberate violation.
- **Hard rule recorded:** delete MOCK ticks/candles or add `source` to the live aggregates before any live provider is enabled.

### Economic calendar
- **Events only,** from the Federal Reserve's FOMC calendar (public domain) and the ECB's meeting schedule (free use with attribution).
- **Fetching:** robots.txt checked, each page fetched at most once a day with a ForexEdge User-Agent.
- **Parsing:** strict parsers keep the last good events on failure.
- **Data:** dates only, so events are all-day (no invented times). Titles are the sources' wording. Impact is a labelled ForexEdge classification. Forecast/previous/actual show "—".
- **UI:** per-event source links, a footer citing the Federal Reserve Board and the ECB, and a note that GBP/JPY events and US data releases aren't available.
- **BLS:** its feed refused our requests (403), so it's skipped pending a decision.
- **Third-party weekly feed removed** (code, cron, config). Its 20 rows were deleted by a logged migration, and a test fails on any reference to it.

## Verification
- **Tests on real recorded data:** the official pages (sha256 pinned), the market-service feed-status responses, a recorded tick and a recorded calendar API response.
- **Default config over HTTP:** feed `off`; an order is rejected with "No live price for EUR/USD"; 1,932 leftover simulated ticks were skipped.
- **Offline:** the default suite makes no external calls; domain-service tests fail on any real `fetch`.
- **Clean matrix:** `nx reset`, empty `dist/`: lint, typecheck, test and build pass for all 18 projects. Jest 651 (+61), pytest 150 + 47.
- **Opt-in DB suites:** market-data-import 67/67, order-service 204/204, domain-service 38/38.

## Not in scope
A live provider (none fits), Replay mode (step 6b), research-agent changes, deployment, new pairs.

Write-up: `docs/phase-summaries/step-6a-price-safety-calendar.md`.
````
