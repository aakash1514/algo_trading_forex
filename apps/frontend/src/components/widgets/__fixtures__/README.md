# Economic calendar fixtures

Real responses, saved byte for byte. Nothing here is written or edited by hand.

| File | What | Recorded | sha256 |
|---|---|---|---|
| calendar-2026-11-06-ff.json | `GET /api/domain/calendar?from=2026-11-06` from domain-service right after the `CalendarThirdPartyEvents` migration and the first Forex Factory sync on the dev database | 2026-11-06, step 6a follow-up (group F working tree) | `4d1b83f6ea2fa0224935a433954cf97edce4fcbce9905663211ca43e1cde7d44` |

The response lists 48 events from 2026-11-06 on: Forex Factory 22 (`third_party`, the rest of that export's
week), ECB 17 (`official`) and FOMC 9 (`expected`). The earlier recordings (`calendar-2026-10-12.json`,
date-only; `calendar-2026-11-06.json`, FOMC and ECB only) were replaced by this one.
