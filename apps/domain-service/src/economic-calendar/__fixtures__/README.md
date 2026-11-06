# Official calendar fixtures

Real pages, byte for byte as served (git keeps their bytes: `-text` in `.gitattributes`). Nothing here is
written or edited by hand. Recorded 2026-10-12 with the calendar's User-Agent of the time
(`ForexEdge/0.1 (economic calendar; +https://github.com/aakash1514/algo_trading_forex)`), one request each,
5 s apart. To re-record (opt-in; the default test suite never fetches anything):
`npx ts-node --transpile-only tools/ops/record-calendar-fixtures.ts`.

| File | URL | sha256 |
|---|---|---|
| fomccalendars.htm | https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | `f0ebb8076d2c75c0a7b2d4affabf7b4141a3b2968a0ed4431d82ea0ba5ee6028` |
| ecb-mgcgc-index.en.html | https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html | `ed2138656be0cd12fa1d8ce86eb89edde8b46e8b3eb3339c0b489a30023eb9ce` |

## FOMC statement evidence (`fomc-statements/`)

The FOMC calendar lists dates only, and the Fed publishes no standing release time for its statement. The
calendar's EXPECTED FOMC time (2:00 p.m. New York on a meeting's final day, `FOMC_EXPECTED_TIME`) rests on these
press releases: the statements of the 8 most recent scheduled meetings, recorded once on 2026-11-06 with
`tools/ops/record-fomc-statement-fixtures.ts` (User-Agent `ForexEdge (+https://github.com/aakash1514/algo_trading_forex)`,
one request each, 5 s apart; federalreserve.gov has no robots.txt). Each says "For release at 2:00 p.m." EST or
EDT (`fomc-statement-evidence.spec.ts`). The service never fetches statement pages.

| File | URL | Release line | sha256 |
|---|---|---|---|
| monetary20261028a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm | 2:00 p.m. EDT | `d8c2677aaf339cafd65a13a732d948fe64d04067d4ad5fa6336768ced81fe291` |
| monetary20260916a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm | 2:00 p.m. EDT | `4a34ebbef9fade34a69f62d8d65e2ccb5062cdd3a562d62d8e29ed594b738f7e` |
| monetary20260729a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm | 2:00 p.m. EDT | `d543d371bbaddf5e3149d3920a952336bed1df3fb4c05adb7e6bb25d85e57eab` |
| monetary20260617a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20260617a.htm | 2:00 p.m. EDT | `e9c6128e59b063223d94a77ef6b525be71f558dcd068673dd46e8ce2aa461af0` |
| monetary20260429a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20260429a.htm | 2:00 p.m. EDT | `30b336ad76e81626aa914ed349bb40f4e06e9b3b73a790ad511138f283f09fce` |
| monetary20260318a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20260318a.htm | 2:00 p.m. EDT | `c0fc7d6e8f60727a423c7f2811730fa2935ef6186099f451effcea242d4c9777` |
| monetary20260128a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20260128a.htm | 2:00 p.m. EST | `3f2ddb932e04042717e6180fdd4e452c9b101affc867ecd98cb796e710fd0339` |
| monetary20251210a.htm | https://www.federalreserve.gov/newsevents/pressreleases/monetary20251210a.htm | 2:00 p.m. EST | `9e10cfd8209d8ae0a90c63adcca8b4786a72148518fd93fd319416d2be483250` |

## robots.txt

Checked 2026-10-12 (federalreserve.gov again 2026-11-06): federalreserve.gov has none (its /robots.txt is a 404 page, so no rules
apply); ecb.europa.eu does not disallow /press/calendars/ and asks for a 5 s crawl delay. bls.gov's ICS
feed answered 403 to the same User-Agent (docs/OVERNIGHT-QUESTIONS.md #5), so there is no BLS fixture.
