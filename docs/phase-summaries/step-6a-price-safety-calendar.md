# Roadmap step 6a: price safety and an official economic calendar

**Outcome:** ForexEdge no longer shows or trades on prices it can't stand behind.
- **No feed by default.** market-service starts no stream unless `MARKET_FEED` names one. The terminal says "No live
  market feed — historical Replay mode is coming", and order-service rejects every order with "No live price".
- **Simulated prices only on request, and labelled.** The random simulator runs only with `MARKET_FEED=mock`, and every
  place it shows says "SIMULATED PRICES — not market data".
- **Every traded price is checked.** order-service checks each price's source and age, so a stale, missing or
  wrongly sourced price never fills an order or triggers an exit.
- **The history is protected.** Live ticks provably can't reach the imported history.
- **An events-only calendar with exact UTC times.** FOMC and ECB decisions come from their official calendars; all
  other events come via Forex Factory's own weekly export, approved by the owner for portfolio use only. Direct BLS
  access is blocked (HTTP 403, 2026-11-06).

There is no live price provider. Twelve Data's free plan doesn't fit (§2). Branch `step-6-live-data` (2026-10-12,
follow-up 2026-11-06), not merged.

## 1. What was built

| Commit | What |
|---|---|
| `18449b5` | Price age and source checks (order-service `PriceFeedPolicy`, libs/common `market-feed.ts`) |
| `8799173` | `MARKET_FEED` (none/mock), feed status with backoff, no fallback, no feed by default |
| `654def3` | Tests proving live ticks never reach `historical_*` (DB + static) |
| `b2af2fd` | Terminal states: no feed, SIMULATED, STALE; order entry gated |
| `9380251` | Events-only calendar from the FOMC and ECB official calendars |
| `9278a9e` | The third-party weekly calendar fetcher removed, its 20 rows deleted, grep test |
| `43e70e2` | Offline guard for domain-service tests, docs, clean matrix (first close-out) |
| `fc1c8fc` | Exact UTC release times: ECB `official`, FOMC `expected`; migration `CalendarEventTimes` |
| `6b7666a` | Calendar warning window (±30 min, inclusive) on exact UTC times, with DB boundary and DST tests |
| `ba4a09a` | The old feed flag removed; a test checks the `MARKET_FEED` docs |
| `7bfc829` | Forex Factory weekly export for all non-FOMC/ECB events; migration `CalendarThirdPartyEvents` |
| `247383e` | Calendar warning matches the event currency to the order's pair (tests on the real export) |
| `1a9fc4f` | No personal data in outbound requests or the repository (rule and tests) |
| close-out 2 | Phase summary, validation reruns (this commit) |

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
- `USE_MOCK_DATA` (the old flag) is no longer read. The follow-up also removed its startup warning: an old `.env`
  line is simply ignored, which is safe because the default is no feed. A test fails if the old name appears
  anywhere outside `docs/` (this summary explains the rename).

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

**Sources** (domain-service `economic-calendar/`)

| Source | What | Time | `time_source` | Terms | robots.txt |
|---|---|---|---|---|---|
| Federal Reserve Board, FOMC calendar | Scheduled meetings (decision on the final day); notation votes and unscheduled meetings skipped | 14:00 New York, **expected** (below) | `expected` | Public domain, cite the Board | None (404) |
| ECB, Governing Council schedule | Monetary policy decisions only ("Day 2, followed by press conference"); Day 1, non-monetary, General Council and standalone press conference entries skipped | 14:15 Frankfurt, from the ECB's monetary policy decisions page ("published in a press release at 14:15 CET") | `official` | Free use, cite the ECB | `/press/calendars/` allowed, 5 s delay |
| Forex Factory weekly export (`ff_calendar_thisweek.json`, linked from the "Weekly Export" panel of forexfactory.com/calendar) | Every other timed event, all currencies and impact levels | The time with the UTC offset the export gives | `third_party` | **Approved by the owner on 2026-11-06 for portfolio use; terms not confirmed for commercial use; must be re-checked or replaced before any client/commercial use** | Both hosts allow it |
| BLS (CPI, Employment Situation) | Not included: **HTTP 403** even with the owner-approved contact email in the User-Agent (one request, 2026-11-06). Not worked around; the work is parked on branch `step-6a-bls-wip` | | | Public domain | `/schedule/news_release/` allowed |

**Why the FOMC time is "expected".** The Fed publishes no standing release time for the statement. The statements of
the 8 most recent scheduled meetings (Dec 2025 to Oct 2026), recorded once as fixtures, all say "For release at
2:00 p.m." (EST for two, EDT for six). `fomc-statement-evidence.spec.ts` checks every one. The UI shows the time as
"(expected)" with the note "Fed publishes no standard release time; based on recent statements." Statement pages
are never fetched at runtime.

**Times**
- Every event is stored at its release moment in UTC (`scheduled_at`).
- FOMC/ECB local times are converted with IANA zones (`zoned-time.ts`, `Intl`, DST from the time zone database). A
  local time skipped or repeated by a DST change throws instead of being guessed.
- Forex Factory times use the export's own offset; a date without an offset throws (no zone is ever assumed).
- **DST on real dates:**
  - FOMC 18 Mar 2026 is 18:00 UTC (New York on EDT since 8 Mar, Europe not until 29 Mar).
  - ECB 29 Oct 2026 is 13:15 UTC (Frankfurt on CET since 25 Oct, New York not until 1 Nov).
  - The Forex Factory fixture's week contains the US change, but every timed entry comes after it.

**Fetching**
- **User-Agent** `ForexEdge (+https://github.com/aakash1514/algo_trading_forex)` for every source, with no email and
  no other headers.
- **Limits:** FOMC and ECB at most once per UTC day; Forex Factory at most twice. The Redis `SET NX` claim per source
  and slot (half days for Forex Factory) is made before the request.
- **Crons:** 06:15 UTC (all sources) and 18:15 UTC (Forex Factory).
- **Failures:** any non-200 (403, 429), a non-JSON or challenge answer, or a page that doesn't parse gives one log
  line. The last good events are kept, with no retry and no workaround.

**Parsing and storing**
- **Strict parsers** throw `CalendarParseError` on unexpected markup or an empty result.
- **What's skipped:** Forex Factory Holiday, Non-Economic and local-midnight entries (possibly All Day/Tentative; their
  titles are logged) are skipped and counted. Its rows for the FOMC/ECB decisions are dropped by exact title:
  - USD: `Federal Funds Rate`, `FOMC Statement`, `FOMC Press Conference`, `FOMC Economic Projections`;
  - EUR: `Main Refinancing Rate`, `Monetary Policy Statement`, `ECB Press Conference`.
- **Replacing:**
  - FOMC/ECB replace their events from today on.
  - Forex Factory replaces exactly its export's week (earliest to latest entry) in one transaction. This is tested by
    failing the 50th insert: the stored week is untouched.
  - Earlier weeks stay.
- **The resync key** is `(source, scheduled_at, currency, title)`. The export lists e.g. the CAD and USD
  "Unemployment Rate" at the same moment; without the currency one of them would have been dropped.
- **Events only:** forecast, previous and actual stay null.

**Impact**
- FOMC/ECB: a fixed ForexEdge classification (`impact.ts`). Every stored FOMC/ECB event is a policy decision, so
  all are HIGH.
- Forex Factory: its own level (High/Medium/Low → HIGH/MEDIUM/LOW), labelled "ForexFactory impact" in the UI.

**Migrations**
- **`CalendarEventTimes`:**
  - Deleted the date-only rows. The dev DB had ECB 55 and FOMC 0 (the 2026-10-12 FOMC fetch had failed); the log
    reads "deleted all-day events per source: ECB 55; rows left 0".
  - Replaced `all_day` with `time_source`.
  - Refuses timed rows of unknown origin.
- **`CalendarThirdPartyEvents`:** allows `third_party` and widens the column for it. `down()` refuses while
  third-party rows exist.
- The 20 rows deleted earlier in 6a are not restored.

**UI**
- Times in UTC, labelled, e.g. "Wed 9 Dec 2026 · 19:00 UTC (expected)".
- Forex Factory rows say "via ForexFactory".
- The footer cites the Federal Reserve Board, the ECB and Forex Factory.
- Coverage: "FOMC and ECB from official sources; all other events via Forex Factory. Direct BLS access is blocked
  (HTTP 403, 2026-11-06)."
- Currency filters cover the export's currencies.

**Consumers**
- **Gate 5** (order-service, warning only, order of gates unchanged): it warns on events of impact HIGH or MEDIUM
  (so Forex Factory High and Medium), in the base or quote currency of the order's pair, from 30:00 before to 30:00
  after the order (both inclusive).
  - **Boundaries:** tested in Postgres at −30:00/−30:01/+30:00/+30:01.
  - **Currency matching:** tested on the real export. USD news warns for EUR/USD, GBP/USD, USD/JPY and XAU/USD; JPY
    for USD/JPY only; AUD and CNY for none.
- `forex.calendar-events` (no consumer) now publishes approaching events from every source.

**Guards**
- A test fails on the Forex Factory name outside its adapter, the places that wire it in or show it, and docs. It
  failed on a planted file.
- `no-personal-data.spec.ts` checks that no calendar User-Agent carries an email and that no tracked file contains
  the owner's addresses (matched by sha256). It failed on a planted, staged file.

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
- **Follow-up (2026-11-06):**
  - **BLS 403 again.** Even with the approved contact email in the User-Agent, one request answered 403. Not worked
    around; parked on `step-6a-bls-wip`.
  - **No FOMC release time is published.** The Fed documents no standing time. Fix: an `expected` time backed by 8
    recorded statements, labelled in the UI.
  - **Same release, two currencies.** The old unique key `(source, scheduled_at, title)` would have dropped the CAD
    or the USD "Unemployment Rate". Fix: the key includes the currency.
  - **`time_source` too short.** `third_party` is 11 characters in a `VARCHAR(10)` column. Fix: the migration widens it.
  - **A test relied on row order.** Two CAD events at 13:30 have no defined order. Fix: select by title.
  - **My test titles tripped the name scan.** Fix: neutral wording outside the allowed files.
  - **`backtest:verify` defaults to two pairs.** A default run would have dropped USD/JPY from the committed report.
    Fix: rerun with `--pairs EUR_USD,XAU_USD,USD_JPY`, as in step 3.
  - **ts-node cold start (~45 s)** made a one-off script look hung. I killed it and used grep.
  - **My mistake:** to stop domain-service I first ran a command that would have stopped every Node process. The
    permission check refused it; I stopped only the process on port 3003.
- **Jest "worker failed to exit".** Seen for order-service (pre-existing, also in step 5b's matrix) and occasionally for
  ws-gateway and domain-service under parallel load. Both are clean in isolation.

## 7. Results

- **Default config** (current `.env`: no `MARKET_FEED`, an old `USE_MOCK_DATA` line), checked over HTTP with every
  service running in compiled mode on 2026-10-12:
  - `GET /api/market/feed/status`: `{"feed":"none","source":null,"simulated":false,"state":"off",...}`;
  - a market order as research_demo: `REJECTED | No live price for EUR/USD`;
  - market-service warned that `USE_MOCK_DATA` was no longer read and that no feed ran (the follow-up removed that
    warning);
  - order-service skipped 1,932 leftover simulated ticks;
  - `/dashboard` and `/calendar` returned 200.
- **Mock mode** (`MARKET_FEED=mock`): feed status connected, simulated true, ticks published.
- **Real calendar sync, dev database, 2026-11-06.** All requests used the plain ForexEdge User-Agent, and every one
  answered HTTP 200:
  - FOMC and ECB at 08:48 UTC, right after `CalendarEventTimes`;
  - Forex Factory at 10:34 UTC, right after `CalendarThirdPartyEvents` (the morning slot).

  | Source | `time_source` | Impact | Rows | First (UTC) | Last (UTC) |
  |---|---|---|---|---|---|
  | FOMC | expected | HIGH | 56 | 2021-01-27 19:00 | 2027-12-08 19:00 |
  | ECB | official | HIGH | 17 | 2026-12-17 13:15 | 2028-12-07 13:15 |
  | Forex Factory | third_party | HIGH | 19 | 2026-11-03 03:30 | 2026-11-06 21:45 |
  | Forex Factory | third_party | MEDIUM | 15 | 2026-11-02 15:00 | 2026-11-06 15:00 |
  | Forex Factory | third_party | LOW | 78 | 2026-11-02 00:00 | 2026-11-06 20:00 |

  - **Forex Factory, week of 1-6 Nov 2026:** 115 entries, 112 stored. Skipped: holiday 3, Non-Economic 0, midnight 0.
    Duplicates of FOMC/ECB: 0 (no FOMC or ECB decision that week).
  - **BLS:** one request (`cpi.htm`) with the approved contact email answered **HTTP 403**, before BLS was parked.
- **Requests to official/third-party hosts on 2026-11-06:**
  - federalreserve.gov: robots.txt 404, 8 statement pages 200, calendar 200;
  - ECB: calendar 200;
  - bls.gov: 1 request, 403;
  - forexfactory.com: robots.txt 200, calendar page 200;
  - nfs.faireconomy.media: robots.txt 200, export 200 twice (the fixture, then the service's sync).

## 8. Commands

```sh
MARKET_FEED=mock npx nx serve market-service      # simulated prices (development only); default: no feed
curl http://localhost:3002/api/market/feed/status
RUN_DB_TESTS=true npx nx test market-data-import --testFile=live-isolation.db.spec.ts --skip-nx-cache
RUN_DB_TESTS=true npx nx test domain-service --skip-nx-cache        # calendar sync into the _test database
npx ts-node --transpile-only tools/ops/record-calendar-fixtures.ts  # opt-in: re-record the official pages
npx ts-node --transpile-only tools/ops/record-fomc-statement-fixtures.ts  # run once: the FOMC statement evidence
RUN_DB_TESTS=true npx nx test order-service --skip-nx-cache         # calendar gate: boundaries, DST, currencies
npm run migration:run                    # EconomicEventSource ... CalendarEventTimes, CalendarThirdPartyEvents
npm run backtest:verify -- --pairs EUR_USD,XAU_USD,USD_JPY          # keep all three pairs in the report
```

## 9. Close-out

**Clean matrix (follow-up, 2026-11-06, commit `1a9fc4f`)**
- Steps: `npx nx reset`, `dist/` deleted, then `npx nx run-many -t lint typecheck test build --parallel=2`.
- **All 18 projects pass** (791 s).
- ESLint: 0 errors, 48 warning lines (as before). None is on a line this step wrote.
- Jest: 684 passed (651 at the first close-out, plus 33), 38 skipped (the DB suites).
- pytest: research-agent 150 passed, 80 skipped; ml-service 47 passed, 30 skipped. Neither changed.
- Jest printed "worker failed to exit" once each for domain-service, market-service and order-service, with every
  test passing. This was already seen in 6a and step 5b.
- The first close-out's matrix (2026-10-12) also passed all 18 projects (678 s, Jest 651).

**Validation reruns (2026-11-06)**
- `npm run data:validate`: all checks pass. Only the report's date line changed.
- `npm run backtest:verify -- --pairs EUR_USD,XAU_USD,USD_JPY`: EUR/USD 257 trades, XAU/USD 217 and USD/JPY 215, each
  **MATCH** against the independent SQL reproduction. Only the report's date, commit and run ids changed.

**Offline proof**
- domain-service, the only service here with outbound HTTP, runs its tests with `jest.setup.cjs` replacing `fetch` by
  a function that throws. A test calls the real fetcher and expects that error.
- Market-service has no networked provider (the simulator is local), and the frontend tests mock `fetch` explicitly.
- No Twelve Data key exists anywhere.

**Opt-in suites** (`RUN_DB_TESTS=true`, `--skip-nx-cache`, follow-up runs)

| Suite | Result |
|---|---|
| market-data-import (includes the live-isolation test and the migration walk-down through `CalendarThirdPartyEvents`) | 67/67 |
| order-service (includes the calendar gate's boundary, DST and currency tests) | 216/216 |
| domain-service (calendar sync into the _test database, atomic weekly replace, both calendar migrations) | 65/65 |

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
- **How do you build a calendar without inventing data?** Use sources whose terms permit the use, keep their
  wording, store only events with a known release time, label the impact classification as ours, and keep the last
  good data when a page changes.
- **The Fed publishes no release time. How do you time FOMC events?** As an `expected` time, labelled as such: the
  time the 8 most recent statements carried, recorded and checked by a test. The UI says it's expected, and the
  warning gate treats it like any other time.
- **How do you handle time zones?** Store UTC instants. Convert official local times with IANA zones (never fixed
  offsets), throw on a local time that doesn't exist or is ambiguous, and take third-party times only with an
  explicit offset. Test real dates between the US and EU DST switches.
- **Why accept a third-party calendar?** It's an explicit, written owner decision with a scope (portfolio only),
  a re-check before any commercial use, and hard rules: one plain request at most twice a day, and never a
  workaround for a block. A test keeps the name confined to its adapter.

## 11. Keywords

Price staleness, fail-closed order gates, feed health and exponential backoff, no-silent-fallback, data licensing
(display vs non-display, commercial use), robots.txt and crawl etiquette, strict HTML parsing, idempotent upserts,
TimescaleDB continuous aggregates, Nx module boundaries.

## 12. Open items

- **Forex Factory before any client/commercial use.** Its terms aren't confirmed for commercial use, so the source
  must be re-checked or replaced first (CLAUDE.md exception).
- **A positive duplicate test.** Record the week of 7–11 Dec 2026 (FOMC 9 Dec) and add a positive duplicate test;
  also the ECB week of 17 Dec.
- **BLS** stays blocked (HTTP 403). The work is on branch `step-6a-bls-wip` (OVERNIGHT-QUESTIONS #5, resolved).
- **Replay mode** (step 6b).
- **A licensed live provider** with bid/ask and display rights; before enabling it, follow the mixed-candles rule.
- **The market-service DB login** with INSERT on `ticks` only (step 7).
- **The unreachable OANDA provider file** remains in market-service (not wired to any `MARKET_FEED` value).
- **One REJECTED order row on research_demo**, from the default-config check.

## 13. Pull request

Not opened (as instructed). Compare: https://github.com/aakash1514/algo_trading_forex/compare/main...step-6-live-data?expand=1

**Title:** `Step 6a: price safety, no feed by default, and an economic calendar with exact UTC times`

**Description:**

````markdown
## Summary
ForexEdge no longer shows or trades on prices it can't stand behind. The economic calendar now gives every event an exact UTC time: FOMC and ECB from official sources, all other events via Forex Factory.

**No live provider.** Twelve Data's free plan has no bid/ask and about one price every 5–7 minutes on 800 credits/day. Gold is on paid plans only, and the terms allow personal, non-display, non-commercial use. Research and quotes are in `docs/phase-summaries/step-6a-price-safety-calendar.md` §2.

### Price safety
- **`MARKET_FEED=none|mock`** replaces the old flag. `none` is the default; any other value fails startup. A test fails if the old name reappears outside `docs/`, and checks the docs.
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
- **Exact UTC times** for every event, with `time_source`:
  - **ECB** monetary policy decisions: 14:15 Frankfurt, from the ECB's own decisions page (`official`).
  - **FOMC** scheduled meetings: 14:00 New York on the final day (`expected`). The Fed publishes no standard release time; the last 8 statements, recorded and checked by a test, all say "For release at 2:00 p.m.". The UI shows "(expected)" with that note.
  - Local times are converted with IANA zones (DST included, never fixed offsets) and tested on real dates between the US and EU switches.
- **Forex Factory weekly export** (`third_party`) for all other events. Approved by the owner on 2026-11-06 for portfolio use; terms not confirmed for commercial use; must be re-checked or replaced before any client/commercial use. Never work around their bot protection.
  - **Fetching:** one plain request at most twice a day. A 403, 429, challenge page or non-JSON answer is logged and skipped, and the last good data is kept.
  - **Data:** times use the export's own UTC offset. Holiday, Non-Economic and local-midnight entries are skipped and counted, and its FOMC/ECB decision rows are dropped as duplicates.
  - **Storage:** each sync replaces its week in one transaction. The impact is shown as "ForexFactory impact" and rows say "via ForexFactory".
- **BLS:** direct access is blocked (HTTP 403 on 2026-11-06, even with an approved contact email in the User-Agent). Not worked around; the work is parked on branch `step-6a-bls-wip`.
- **Order warning (gate 5, never blocks):** HIGH/MEDIUM events in the order pair's base or quote currency, from 30:00 before to 30:00 after the order (both inclusive). Boundaries, DST and currency matching are tested in Postgres on real events.
- **Personal data:** no outbound request carries personal data (tested), and a sha256 scan keeps the owner's addresses out of the repository.
- **The old third-party fetcher** from before 6a is gone. Its 20 rows were deleted and are not restored. A test confines the Forex Factory name to its adapter, the places that wire it in or show it, and docs.

## Verification
- **Tests on real recorded data:**
  - the official pages and the 8 FOMC statements, sha256 pinned;
  - one Forex Factory export, sha256 pinned;
  - market-service feed-status responses, a recorded tick, and recorded calendar API responses.
- **Real sync (dev DB, 2026-11-06, all HTTP 200):** FOMC 56 (`expected`), ECB 17 (`official`), Forex Factory 112 (High 19, Medium 15, Low 78; holiday 3 skipped; 0 duplicates).
- **Offline:** the default suite makes no external calls; domain-service tests fail on any real `fetch`.
- **Clean matrix:** `nx reset`, empty `dist/`. Lint, typecheck, test and build pass for all 18 projects. Jest 684, pytest 150 + 47.
- **Opt-in DB suites:** market-data-import 67/67, order-service 216/216, domain-service 65/65.
- **Validation reruns:** `data:validate` all pass; `backtest:verify` EUR/USD 257, XAU/USD 217, USD/JPY 215 trades, all MATCH.

## Not in scope
A live provider (none fits), Replay mode (step 6b), research-agent changes, deployment, new pairs, BLS (blocked).

Write-up: `docs/phase-summaries/step-6a-price-safety-calendar.md`.
````
