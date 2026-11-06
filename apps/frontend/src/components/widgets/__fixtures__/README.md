# Economic calendar fixtures

Real responses, saved byte for byte. Nothing here is written or edited by hand.

| File | What | Recorded | sha256 |
|---|---|---|---|
| calendar-2026-11-06.json | `GET /api/domain/calendar?from=2026-11-06` from domain-service right after the `CalendarEventTimes` migration and its first sync with release times on the dev database | 2026-11-06, step 6a follow-up (group A working tree) | `eec4d2522b79ffb99b47cce76056aea5e88a5ab72064eaf3afba30a32ca60fe8` |

That sync stored FOMC 56 events (time source `expected`) and ECB 17 (`official`); the response lists the 26 from
2026-11-06 on. The date-only response recorded on 2026-10-12 (`calendar-2026-10-12.json`) was removed with the
all-day layout.
