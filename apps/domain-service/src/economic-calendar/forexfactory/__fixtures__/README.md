# Forex Factory export fixture

One real response of Forex Factory's own weekly calendar export, byte for byte as served (git keeps its bytes:
`-text` in `.gitattributes`). Nothing here is written or edited by hand.

| File | URL | Recorded | sha256 |
|---|---|---|---|
| ff_calendar_thisweek-2026-11-06.json | https://nfs.faireconomy.media/ff_calendar_thisweek.json | 2026-11-06T09:54:37Z, HTTP 200, `Content-Type: application/json`, 15,650 bytes (`Last-Modified: Fri, 06 Nov 2026 09:42:18 GMT`) | `8580a420686aa4c908bed876f441c0f8f43a402b845f3f9f4e341df923ad6d49` |

**Where the URL comes from.** The "Weekly Export" panel on https://www.forexfactory.com/calendar links ICS, CSV,
JSON and XML files at `https://nfs.faireconomy.media/ff_calendar_thisweek.<ext>?version=<hash>`. The adapter uses
the JSON path without the changing `version` cache-buster. Reading the hash would mean parsing their HTML, which
we don't do.

**robots.txt (2026-11-06).** forexfactory.com has a `Sitemap:` line only, with no Disallow rule. nfs.faireconomy.media
is `User-agent: *` with an empty `Disallow:`.

**Requests.** One request each to forexfactory.com/robots.txt, forexfactory.com/calendar, nfs.faireconomy.media/robots.txt
and the export, 5 s apart, with `ForexEdge (+https://github.com/aakash1514/algo_trading_forex)` and no other headers.

**Content.** Week of 1-6 Nov 2026: 115 entries, every `date` with the offset `-05:00`.
- Impact: High 19, Medium 15, Low 78, Holiday 3. No Non-Economic entries and no entry at local midnight.
- The week contains the US DST change (1 Nov, 02:00 New York), but every timed entry comes after it.
- No FOMC or ECB decision this week; the RBA and BOE decisions are in it.

**Licensing.** Approved by the owner on 2026-11-06 for portfolio use. The terms are not confirmed for commercial use,
and the source must be re-checked or replaced before any client/commercial use. Never work around their bot protection.

**Coverage.** FOMC and ECB come from official sources; all other events come via Forex Factory. Direct BLS access is
blocked (HTTP 403, 2026-11-06).
