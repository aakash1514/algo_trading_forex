# Official calendar fixtures

Real pages, byte for byte as served (git keeps their bytes: `-text` in `.gitattributes`). Nothing here is
written or edited by hand. Recorded 2026-10-12 with the calendar's own User-Agent
(`ForexEdge/0.1 (economic calendar; +https://github.com/aakash1514/algo_trading_forex)`), one request each,
5 s apart. To re-record (opt-in; the default test suite never fetches anything):
`npx ts-node --transpile-only tools/ops/record-calendar-fixtures.ts`.

| File | URL | sha256 |
|---|---|---|
| fomccalendars.htm | https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | `f0ebb8076d2c75c0a7b2d4affabf7b4141a3b2968a0ed4431d82ea0ba5ee6028` |
| ecb-mgcgc-index.en.html | https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html | `ed2138656be0cd12fa1d8ce86eb89edde8b46e8b3eb3339c0b489a30023eb9ce` |

robots.txt (checked 2026-10-12): federalreserve.gov has none (its /robots.txt is a 404 page, so no rules
apply); ecb.europa.eu does not disallow /press/calendars/ and asks for a 5 s crawl delay. bls.gov's ICS
feed answered 403 to the same User-Agent (docs/OVERNIGHT-QUESTIONS.md #5), so there is no BLS fixture.
