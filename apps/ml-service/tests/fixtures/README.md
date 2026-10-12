# Real H1 bar fixtures

Verbatim exports of `historical_candles_1h` (the imported Dukascopy history, roadmap
step 2), exported 2026-10-11. Prices are integer points (EUR/USD 5 decimals, USD/JPY 3).
Nothing here is generated or edited.

```sql
COPY (SELECT (extract(epoch FROM bucket) * 1000)::bigint AS bucket_ms,
             bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close, minutes
      FROM historical_candles_1h
      WHERE pair = :pair AND bucket >= :from AND bucket < :to ORDER BY bucket)
TO STDOUT WITH (FORMAT csv, HEADER)
```

| File | Pair | Window (UTC, end exclusive) | Bars | sha256 |
|---|---|---|---|---|
| `EURUSD-H1-2022-01.csv` | EUR/USD | 2022-01-01 .. 2022-02-01 | 506 | `565e0fe2d0f1a6141d63db2109fdaeada991a230c220d4fff85eedd1e8d06a33` |
| `USDJPY-H1-2022-01.csv` | USD/JPY | 2022-01-01 .. 2022-02-01 | 506 | `19683ca63e422ec866003a7f4c244ff1b2bc33a93cb991bae6bfdd588180a14b` |
| `EURUSD-H1-2015-12-21-to-2016-01-08.csv` | EUR/USD | 2015-12-21 .. 2016-01-09 | 320 | `2f3493471851e44424c3154b7bb494c0e6f4fd7ef70abf9061239932743722b0` |
| `EURUSD-H1-2012-12-27-to-2013-01-04.csv` | EUR/USD | 2012-12-27 .. 2013-01-05 | 143 | `faed26eb9d1a9603ac082a254f09acb6afc53e61ce6c519ba6bd51c45e92e00f` |

What they cover:
- EUR/USD January 2022 has three flat bars (mid open = mid close): 2022-01-16 22:00,
  2022-01-18 09:00 and 2022-01-19 14:00 UTC.
- 2015/2016 crosses a year boundary (walk-forward split edges).
- 2012/2013 holds the real 16-minute bar at 2012-12-31 22:00 (below the 30-minute
  target minimum) and the New Year's Day gap.
