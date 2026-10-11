# ForexEdge M1 export (JForex strategy)

`ForexEdgeM1Export.java` exports Dukascopy one-minute **bid and ask** bars to CSV for roadmap step 2. It runs inside
Dukascopy's own JForex 4 platform and uses only the documented strategy API (`IHistory.getBars`). It places no orders.

**Why this route:** Dukascopy's HTTP data endpoints are behind bot protection, and its bulk S3 export needs an AWS
account. JForex is Dukascopy's official client, and its history in demo is the same data as live. Never work around
the bot protection.

The file is not part of the Nx build. JForex compiles it.

## 1. Demo account and platform
1. Open a free demo: <https://www.dukascopy.com/swiss/english/forex/demo-fx-account/>. Choose **JForex 4** and a USD
   account. The login arrives by email.
2. Demo accounts **expire after 14 days**. If one expires mid-export, open a new demo and run the strategy again:
   finished files are skipped, and JForex keeps its downloaded history in a local cache.
3. Install the JForex 4 desktop platform from Dukascopy's site and log in to the **Demo** server.

## 2. Install and compile the strategy
1. Copy `ForexEdgeM1Export.java` into `Documents\JForex\Strategies\`.
2. In the left sidebar, open **Strategies**. If the file isn't listed, right-click and open or import it.
3. Right-click the strategy and choose **Compile**. The console should report a successful compile.

Menu labels can differ slightly between JForex 4 versions.

## 3. Run it
Right-click the strategy, choose **Run** (local run), and set the parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `instruments` | `EURUSD,GBPUSD,USDJPY,XAUUSD` | JForex instrument names, comma-separated |
| `fromYear` / `toYear` | `2010` / `2022` | Inclusive year range |
| `fromMonth` / `toMonth` | `1` / `12` | Inclusive month range, applied to every year in the range |

**Calibration runs** (do these first):

| Run | instruments | years | months | Expected rows |
|---|---|---|---|---|
| EUR/USD 2022 | `EURUSD` | 2022–2022 | 1–12 | 525,600 |
| Gold, January 2010 | `XAUUSD` | 2010–2010 | 1–1 | 44,640 |

Then do the full run with the defaults. Progress appears in the console, prefixed `[forexedge-m1]`. The format is
shown below; the numbers are placeholders:

```
[forexedge-m1] EUR/USD 2022: <rows> rows in <seconds>s
[forexedge-m1] XAU/USD 2010-01_01: <rows> rows in <seconds>s, expected 44640; <n> gap(s) written to 2010-01_01.gaps.txt
```

## 4. Output
Files are written under the strategy files folder, normally `Documents\JForex\Strategies\files\forexedge-m1\`:

```
forexedge-m1/EURUSD/2022.csv              full year (months 1-12)
forexedge-m1/XAUUSD/2010-01_01.csv        partial range: <year>-<fromMonth>_<toMonth>
forexedge-m1/XAUUSD/2010-01_01.gaps.txt   only when minutes are missing
```

The CSV has a header, LF line endings and UTF-8 encoding:

```
time_ms,bid_open,bid_high,bid_low,bid_close,bid_volume,ask_open,ask_high,ask_low,ask_close,ask_volume
<epoch ms>,<bid OHLC x4>,<bid volume>,<ask OHLC x4>,<ask volume>
```

- **`time_ms`** is the bar **start** in epoch milliseconds, UTC. The platform's timezone and day-start settings
  don't affect it.
- **Prices** are rounded to one digit past the pip: 5 decimals for EUR/USD and GBP/USD, 3 for USD/JPY and
  XAU/USD. Rounding removes floating-point noise without changing the quoted price.
- **Volumes** are Dukascopy's volumes as delivered (millions of units for FX). ForexEdge doesn't use them in any money
  math.
- **Every minute is exported (`Filter.NO_FILTER`)**, including flat, zero-volume minutes such as weekends. So a
  complete file has exactly one row per minute of its range:
  - 525,600 rows for a full year;
  - 527,040 rows for 2012, 2016 and 2020.
  
  The importer keeps a minute only if bid or ask volume is above 0, meaning at least one tick happened.
- **Bid and ask must line up.** The bid and ask lists for each month have to match bar for bar. If they don't, the
  export stops with an error rather than write a misaligned row.

### Gap files
If the feed returns fewer minutes than the range holds, the CSV is still finished. The missing ranges are listed in
`<name>.gaps.txt`:

```
# <INSTRUMENT> <name>: <rows> rows, expected <rows> (<n> missing minutes)
# first_missing_utc,last_missing_utc,minutes
<ISO-8601 UTC>,<ISO-8601 UTC>,<minutes>
```

Nothing is filled in, so review a gap before importing that file. Re-running won't change it, because Dukascopy's
history doesn't change.

## 5. Resume
- Each file is written as `<name>.csv.part` and renamed to `<name>.csv` only when its whole range is done.
- Stopping the strategy, or losing the demo, leaves at most one `.part` file. The next run rewrites it from the start
  of its range.
- Files that already exist are skipped. Delete a `.csv` (and its `.gaps.txt`) to export it again.
- Partial-range files have different names from full years, so a calibration run never causes a full year to be
  skipped.

## 6. Hand-off to the importer
Copy the `forexedge-m1` folder to `data/raw/jforex/` in the repo, which is gitignored, or pass the importer its path.
The importer (roadmap step 2.3) imports only full-year files. Before importing a year it checks:
- the header;
- that the first row is January 1, 00:00 UTC;
- that rows step by exactly one minute;
- the row count.

A year with a `.gaps.txt` file is imported only after its gaps have been reviewed.
