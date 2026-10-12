# Economic calendar fixtures

Real responses, saved byte for byte. Nothing here is written or edited by hand.

| File | What | Recorded | sha256 |
|---|---|---|---|
| calendar-2026-10-12.json | `GET /api/domain/calendar?from=2026-10-12` from domain-service after its first official-calendar sync on the dev database | 2026-10-12, step 6a (working tree after commit `b2af2fd`) | `e22e684f7902ee0bcb676e7f175f3fcd1f7d8158c82a4e7ad34034fbd12bf8fd` |

That sync stored the ECB's 55 events; the FOMC fetch failed transiently ("fetch failed"), so the service kept
its (empty) last good set and the response has ECB events only. It was not refetched the same day (the
calendar fetches each source at most once a day).
