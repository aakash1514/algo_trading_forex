# Plan: calendar events on the replay chart

Branch `replay-improvements` (PR #20). Backlog item 2.

## What the data allows

`economic_events` holds real events only: FOMC (USD) decisions from 2021-01-27 (the Fed's calendar page lists
2021 onwards), ECB (EUR) decisions from 2026-12, and one week of Forex Factory rows (2026-11). Inside the replay
history (2010-2022) that leaves the **16 FOMC decisions of 2021 and 2022**, all HIGH impact, with no
actual/forecast/previous (the calendar stores events only, CLAUDE.md "Economic calendar"). Nothing is backfilled:
before 2021-01-27 the chart says "No calendar data for this period"; a USD/JPY session in 2022 shows the FOMC
markers; EUR events appear only where ECB rows exist (none before 2026-12, so none in the replay history today).

## No look-ahead: filtered on the server

The server sends an event only once the replay clock has reached its time (`scheduled_at <= clock_time`):

- in the `state` (connect, reconnect, timeframe change): the events from the first history bar to the clock;
- in a new socket event `calendar` after a step: the events in (previous clock, new clock].

The other option (send the period's events and let the browser hide the future ones) would put future events, and
their actual values once the calendar stores them, in the browser's network tab and Redux store before the replay
reaches them. Filtering on the server keeps them off the wire entirely, the same way the server already never sends
a bar after the clock. Every calendar payload also goes through `assertNothingAfterClock` (the event time is sent
as `time`, a checked key), so a query bug throws instead of leaking.

"No calendar data for this period" is a boolean `covered` = "some event for this pair's currencies exists at or
before the clock". It says nothing about the future (it turns true exactly when the first event is shown anyway).

Medium impact: the server sends HIGH and MEDIUM (both are past events, nothing to hide); the toggle filters in the
browser, so flipping it needs no request. LOW is never sent.

Currencies: the pair's two legs, metals dropped (EUR/USD → EUR, USD; XAU/USD → USD; USD/JPY → USD, JPY).

Marker bar: the server returns each event's `barTime`, the start of the session-timeframe bucket that holds the
event time, computed with `historicalBucketSql` (the aggregates' own expressions, so H4/D1 follow the New York close
exactly like the bars). The browser never recomputes buckets.

## Files

| Where | Change |
|---|---|
| `apps/auth-service/src/migrations/1792700000000-ReplayCalendarRead.ts` | `GRANT SELECT ON economic_events TO forexedge_replay_writer` (down: revoke). Additive: the previous release ignores the grant. |
| `apps/domain-service/.../calendar-event-times.migration.db.spec.ts` | its "newest migration" chain gets the new migration |
| `apps/replay-service/src/history/replay-calendar.ts` (new) | `calendarCurrencies(pair)`, `calendarEvents(ds, …)`, `calendarCovered(ds, …)`, the event view |
| `replay-state.service.ts` | `calendar: { covered, events }` in the state |
| `playback.service.ts` | after a step's bar: `calendar` with the events the step passed (none → nothing sent) |
| `apps/replay-service/test/replay-test-db.ts` | loads the real FOMC/ECB events through domain-service's parsers over its recorded official pages (test code, like the importer import) |
| `tools/market-data/import/src/fixtures/EURUSD-2022-01-26-fomc.csv` (new) | verbatim Dukascopy excerpt 17:00-21:00 UTC around the FOMC decision at 19:00 (README updated with the command) |
| frontend `types/replay.types.ts`, `replay.slice.ts`, `useReplaySocket.ts` | `calendar` in the state, the `calendar` event merged by id |
| frontend `ReplayChart.tsx` + `ReplayCalendarBar.tsx` (new) | markers, hover card, Medium toggle, "No calendar data for this period" |
| `record-frontend-fixtures.ts` | records a state and a `calendar` event around the 2022-03-16 18:00 FOMC decision |

## Frontend decisions, in plain words

- **Markers through the chart library's own plugin** (`createSeriesMarkers`): it draws small arrows above the bars
  and moves them with zoom and scroll for free. We give it a list; it does the drawing.
- **Hover card from the crosshair**: the library reports which bar the mouse is over (`subscribeCrosshairMove`);
  if that bar has events we show a small card next to the mouse. Markers themselves have no hover event.
- **Events stored by id in Redux**, like positions: a `state` replaces them all, a `calendar` event adds new ones;
  the same event twice changes nothing.
- **The Medium toggle is local state**: it only changes what is drawn, so it doesn't belong in the shared store.

## Groups (one commit each)

1. Server: migration, `replay-calendar.ts`, state + step event, test DB events, history excerpt, tests.
2. Frontend: types/slice/socket, markers, hover, toggle, empty-period message, recorded fixtures, tests.

## Tests

Server (DB, real minutes and real FOMC/ECB rows):
- clock 18:59 → the 19:00 FOMC event is absent; clock 19:00 → present (1m, 1h, 4h, 1d `barTime` as the buckets)
- stepping 1m from 18:58: no `calendar` before the 19:00 step, the event in the 19:00 step's `calendar`
- currencies: EUR/USD gets FOMC and ECB, USD/JPY only FOMC, XAU/USD only FOMC
- `covered` false before the first stored event, true after; the replay login can read `economic_events`

Frontend (recorded fixtures): markers drawn only for events in the store, HIGH by default, the toggle adds MEDIUM;
hover text; the message when not covered; a `calendar` event adds a marker without reloading the chart.

## Planted faults

- show an event one bar early: `bucket(scheduled_at) <= bucket(clock)` instead of `scheduled_at <= clock` → the
  18:59 test fails
- drop the currency filter → the USD/JPY test fails (ECB EUR rows come back)
