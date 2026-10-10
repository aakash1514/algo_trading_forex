# Reference data for the historical spot checks

Independent references used by `npm run data:validate` (step 2.4,
`tools/market-data/import/src/validate.ts`) to check the imported Dukascopy history.
The files are committed unchanged, as downloaded.

## FRED H.10 noon New York fixings

Federal Reserve Board H.10 noon buying rates in New York, via FRED (Federal Reserve
Bank of St. Louis). One row per business day; days without a rate (US holidays) have an
empty value. The full series is stored; the check uses 2010-2022.

| File | Series | Quote | Same direction as | URL | sha256 |
|---|---|---|---|---|---|
| `DEXUSEU.csv` | U.S. dollars to one euro | USD per EUR, 4 dp | EUR/USD | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXUSEU | `81324d84a8772ee71420e54e21ae12a1995a6a49c6dfa4480c0bc6450aacdc1f` |
| `DEXUSUK.csv` | U.S. dollars to one British pound | USD per GBP, 4 dp | GBP/USD | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXUSUK | `53a5910df5fd6fa2f5b010a68743c53df5aa2ded824510131b282f6e418fde9a` |
| `DEXJPUS.csv` | Japanese yen to one U.S. dollar | JPY per USD, 2 dp | USD/JPY | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXJPUS | `2bd05703ca65d19630c97f372a2ac43ed49d910e77ae1edd535305e667d4b3f9` |

Downloaded 2026-10-10 (19:56 UTC) with plain `curl` from the public CSV endpoint.
All three quote the same way as our pairs, so nothing is inverted.

## Gold

FRED no longer carries an LBMA gold series, so gold is checked against three
documented spot extremes, each with one cited source (quoted in
`GOLD_EXTREMES` in `validate.ts` and in the generated report):

| Extreme | Documented | Source |
|---|---|---|
| 2011 high | $1,920 on 2011-09-06 | JCK, 2011-09-06 — https://jckonline.com/2011/09/06/gold-hits-new-record-over-1900-again-tops-platinum |
| 2015 low | $1,045.85 on 2015-12-03 | PTI via Business Standard, 2015-12-03 — https://www.business-standard.com/amp/article/pti-stories/gold-crashes-to-3-1-2-month-low-global-melt-down-115120301164_1.html |
| 2020 high | $2,072.50 on 2020-08-07 | Reuters via BusinessDay, 2020-08-07 — https://www.businessday.co.za/bd/markets/2020-08-07-gold-hits-new-high-on-soaring-covid-19-cases/ |
