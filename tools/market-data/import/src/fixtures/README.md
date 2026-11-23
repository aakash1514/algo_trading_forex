# Importer test fixtures

Verbatim excerpts of the Dukascopy JForex exports in `data/raw/jforex/` (see
`tools/market-data/jforex/README.md`). Each file is the source header followed by the
source lines whose `time_ms` falls in the range below, unchanged. No row is edited or
made up: the importer's rejection tests use these real rows with a mismatched range or
scale instead.

| Fixture | Source (sha256) | Range (UTC, end exclusive) | Rows |
|---|---|---|---|
| `EURUSD-2022-01-03.csv` | `EURUSD/2022.csv` <br>`f4cd1e32ae8ae85faf902cb95d35bd874d991a25fb47574e9ceb147c520d496f` | 2022-01-03 00:00 – 2022-01-04 00:00 | 1440 |
| `XAUUSD-2022-01-03.csv` | `XAUUSD/2022.csv` <br>`797361928a4c140816c3f9cec6b610969877d3e7a51d9db56b25f521ca1d5057` | 2022-01-03 00:00 – 2022-01-04 00:00 | 1440 |
| `EURUSD-2012-12-31-pm.csv` | `EURUSD/2012.csv` <br>`3b78f7fc8c5b9a4c3419cb32c953cdfbbf017f984b8028aa95cc67f718b15f1b` | 2012-12-31 12:00 – 2013-01-01 00:00 | 720 |
| `EURUSD-2013-01-01-to-02-noon.csv` | `EURUSD/2013.csv` <br>`8459dec917d6877d099b009a3e86663774fd5a1bab47ebcc1961e0ecaa820072` | 2013-01-01 00:00 – 2013-01-02 12:00 | 2160 |
| `EURUSD-2022-01-26-fomc.csv` | `EURUSD/2022.csv` <br>`f4cd1e32ae8ae85faf902cb95d35bd874d991a25fb47574e9ceb147c520d496f` | 2022-01-26 17:00 – 21:00 | 240 |

The 2012/2013 pair covers a real year-boundary case: EUR/USD traded 16 minutes
between 22:00 and 24:00 UTC on 2012-12-31. Those minutes open the New York day that
runs 2012-12-31 22:00 – 2013-01-01 22:00 UTC, so that D1 bar (and its 22:00 H4 bar)
crosses the UTC year boundary.

The 2022-01-26 excerpt holds the minutes around the FOMC decision at 19:00 UTC (the Fed's calendar, recorded in
`apps/domain-service/src/economic-calendar/__fixtures__/fomccalendars.htm`): replay-service's calendar tests step
across it.

Extracted with (run from the repo root):

```sh
ex() { awk -F, -v a="$2" -v b="$3" 'NR==1{print;next} $1>=a && $1<b' "data/raw/jforex/$1" \
  > "tools/market-data/import/src/fixtures/$4"; }
ex EURUSD/2022.csv 1641168000000 1641254400000 EURUSD-2022-01-03.csv
ex XAUUSD/2022.csv 1641168000000 1641254400000 XAUUSD-2022-01-03.csv
ex EURUSD/2012.csv 1356955200000 1356998400000 EURUSD-2012-12-31-pm.csv
ex EURUSD/2013.csv 1356998400000 1357128000000 EURUSD-2013-01-01-to-02-noon.csv
ex EURUSD/2022.csv 1643216400000 1643230800000 EURUSD-2022-01-26-fomc.csv
```

Each was checked line by line against its source (`grep -vxFf <source> <fixture>`
prints nothing).
