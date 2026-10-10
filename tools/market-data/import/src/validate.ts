// Step 2.4: is the imported history correct enough to backtest on?
//
// FX: every FRED H.10 noon New York fixing 2010-2022 (DEXUSEU = USD per EUR,
// DEXUSUK = USD per GBP, DEXJPUS = JPY per USD; each is quoted the same way as
// our pair, so nothing is inverted) against our mid at noon New York: the mid of
// bid and ask close of the 11:59 NY bar (the last price before 12:00:00), or of
// the last traded minute up to 5 minutes earlier. The same comparison shifted by
// -60 and +60 minutes must fit worse than offset 0 in every pair-year, which
// catches a timezone or DST error.
//
// Gold: our yearly extreme against three documented spot extremes, matched on
// the New York trading day.
//
// All arithmetic is exact: fixings go text -> numeric -> points in SQL, and a
// deviation in pips is points / 10 at every pair's scale (1 pip = 10 points).
// Every check fails on empty input.
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';

export interface FxSeries {
  id: string;
  pair: string;
  flagPips: number;
  failPips: number;  // any single day above this fails
  maxMedian: number; // pips, per pair-year
  maxP95: number;    // pips, per pair-year
}

export const FX_SERIES: readonly FxSeries[] = [
  { id: 'DEXUSEU', pair: 'EUR/USD', flagPips: 5, failPips: 20, maxMedian: 1.5, maxP95: 5 },
  { id: 'DEXUSUK', pair: 'GBP/USD', flagPips: 7, failPips: 25, maxMedian: 2, maxP95: 7 },
  { id: 'DEXJPUS', pair: 'USD/JPY', flagPips: 5, failPips: 20, maxMedian: 1.5, maxP95: 5 },
];

export const OFFSETS = [-60, 0, 60] as const;
// Bars searched back from the target minute when it had no volume
export const LOOKBACK_MINUTES = 5;

export interface Fixing {
  date: string;  // YYYY-MM-DD
  value: string; // decimal text, as published
}

// FRED's fredgraph CSV: "observation_date,<ID>" (older files: "DATE,<ID>"), one
// row per business day; holidays have an empty value (older files: ".").
export function parseFredCsv(text: string, seriesId: string): Fixing[] {
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  const header = lines[0];
  if (header !== `observation_date,${seriesId}` && header !== `DATE,${seriesId}`) {
    throw new Error(`${seriesId}: unexpected FRED header "${header}"`);
  }
  const fixings: Fixing[] = [];
  for (const line of lines.slice(1)) {
    const [date, value, extra] = line.split(',');
    if (extra !== undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${seriesId}: bad row "${line}"`);
    if (value === '' || value === '.') continue;
    if (!/^\d+\.\d+$/.test(value)) throw new Error(`${seriesId}: bad value in "${line}"`);
    fixings.push({ date, value });
  }
  return fixings;
}

export function readFredCsv(file: string, seriesId: string): Fixing[] {
  return parseFredCsv(readFileSync(file, 'utf8'), seriesId);
}

export interface FailingDay {
  date: string;
  fixing: string;
  mid: string;
  pips: number;
}

export interface PairYearResult {
  pair: string;
  year: number;
  fixings: number;
  compared: number;
  noData: number;
  medianPips: number | null;
  p95Pips: number | null;
  meanSignedPips: number | null;
  maxPips: number | null;
  maxDate: string | null;
  flagged: number;
  failing: FailingDay[];
  medianByOffset: Record<number, number | null>;
  problems: string[];
  ok: boolean;
}

interface StatsRow {
  year: number;
  offset_min: number;
  fixings: number;
  compared: number;
  median: string | null;
  p95: string | null;
  mean_signed: string | null;
  max_abs: string | null;
  max_date: string | null;
  flagged: number;
}

// Our noon mids for every fixing at each offset, as a SQL CTE body over
// $1 dates, $2 values, $3 pair
const COMPARISON_CTE = `
  fix AS (
    SELECT day, value, value * power(10::numeric, s.price_decimals) AS fix_points
    FROM unnest($1::date[], $2::numeric[]) AS f(day, value)
    CROSS JOIN historical_price_scale s WHERE s.pair = $3
  ),
  cmp AS (
    SELECT fix.day, fix.value, o.offset_min, m.mid_points,
           (m.mid_points - fix.fix_points) / 10 AS pips
    FROM fix
    CROSS JOIN unnest(ARRAY[${OFFSETS.join(', ')}]) AS o(offset_min)
    LEFT JOIN LATERAL (
      SELECT (c.bid_close + c.ask_close)::numeric / 2 AS mid_points
      FROM historical_candles c
      WHERE c.pair = $3
        AND c.time <= ((fix.day + TIME '11:59') AT TIME ZONE 'America/New_York') + o.offset_min * INTERVAL '1 minute'
        AND c.time >= ((fix.day + TIME '11:59') AT TIME ZONE 'America/New_York') + o.offset_min * INTERVAL '1 minute'
                      - INTERVAL '${LOOKBACK_MINUTES} minutes'
      ORDER BY c.time DESC LIMIT 1
    ) m ON true
  )`;

export async function compareSeries(client: Client, series: FxSeries, fixings: Fixing[]): Promise<PairYearResult[]> {
  const byYear = new Map<number, number>();
  for (const f of fixings) byYear.set(Number(f.date.slice(0, 4)), (byYear.get(Number(f.date.slice(0, 4))) ?? 0) + 1);
  if (fixings.length === 0) {
    return [emptyResult(series.pair, 0, `no ${series.id} fixings`)];
  }
  const params = [fixings.map((f) => f.date), fixings.map((f) => f.value), series.pair];

  const { rows: stats } = await client.query<StatsRow>(`
    WITH ${COMPARISON_CTE}
    SELECT extract(year FROM day)::int AS year, offset_min,
           count(*)::int AS fixings,
           count(pips)::int AS compared,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(pips))::text AS median,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY abs(pips))::text AS p95,
           avg(pips)::text AS mean_signed,
           max(abs(pips))::text AS max_abs,
           (array_agg(day::text ORDER BY abs(pips) DESC NULLS LAST))[1] AS max_date,
           count(*) FILTER (WHERE abs(pips) > $4)::int AS flagged
    FROM cmp GROUP BY 1, 2 ORDER BY 1, 2
  `, [...params, series.flagPips]);

  const { rows: failing } = await client.query(`
    WITH ${COMPARISON_CTE}
    SELECT extract(year FROM day)::int AS year, day::text AS date, value::text AS fixing,
           trim_scale(mid_points / power(10::numeric, s.price_decimals))::text AS mid, pips::float8 AS pips
    FROM cmp CROSS JOIN historical_price_scale s
    WHERE s.pair = $3 AND offset_min = 0 AND abs(pips) > $4
    ORDER BY day
  `, [...params, series.failPips]);

  const results: PairYearResult[] = [];
  for (const [year, count] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const at = (offset: number) => stats.find((s) => s.year === year && s.offset_min === offset);
    const zero = at(0);
    const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
    const medianByOffset = Object.fromEntries(OFFSETS.map((o) => [o, num(at(o)?.median)]));
    const result: PairYearResult = {
      pair: series.pair, year, fixings: count,
      compared: zero?.compared ?? 0,
      noData: count - (zero?.compared ?? 0),
      medianPips: num(zero?.median), p95Pips: num(zero?.p95), meanSignedPips: num(zero?.mean_signed),
      maxPips: num(zero?.max_abs), maxDate: zero?.max_date ?? null,
      flagged: zero?.flagged ?? 0,
      failing: failing.filter((f) => f.year === year).map(({ date, fixing, mid, pips }) => ({ date, fixing, mid, pips })),
      medianByOffset,
      problems: [],
      ok: false,
    };
    const p = result.problems;
    if (result.compared === 0) p.push('no day compared');
    if (result.failing.length > 0) p.push(`${result.failing.length} day(s) above ${series.failPips} pips`);
    if (result.medianPips !== null && result.medianPips > series.maxMedian) p.push(`median above ${series.maxMedian} pips`);
    if (result.p95Pips !== null && result.p95Pips > series.maxP95) p.push(`p95 above ${series.maxP95} pips`);
    const m0 = medianByOffset[0];
    for (const o of OFFSETS.filter((x) => x !== 0)) {
      const mo = medianByOffset[o];
      if (m0 === null || mo === null || !(m0 < mo)) p.push(`offset ${o > 0 ? '+' : ''}${o} min fits as well as or better than 0`);
    }
    result.ok = p.length === 0;
    results.push(result);
  }
  return results;
}

export function emptyResult(pair: string, year: number, problem: string): PairYearResult {
  return {
    pair, year, fixings: 0, compared: 0, noData: 0, medianPips: null, p95Pips: null, meanSignedPips: null,
    maxPips: null, maxDate: null, flagged: 0, failing: [], medianByOffset: {}, problems: [problem], ok: false,
  };
}

// ── Gold ─────────────────────────────────────────────────────────────────
export interface GoldExtreme {
  year: number;
  kind: 'high' | 'low';
  date: string;   // New York trading day of the documented extreme
  price: string;  // documented spot price, USD/oz
  source: string;
  url: string;
}

// The spot extremes of the export, each with one cited source.
export const GOLD_EXTREMES: readonly GoldExtreme[] = [
  {
    year: 2011, kind: 'high', date: '2011-09-06', price: '1920.00',
    source: 'JCK, 2011-09-06: "The spot price of gold soared past the $1,900 barrier on Sept. 6, at one point hitting $1,920, a new record."',
    url: 'https://jckonline.com/2011/09/06/gold-hits-new-record-over-1900-again-tops-platinum',
  },
  {
    year: 2015, kind: 'low', date: '2015-12-03', price: '1045.85',
    source: 'PTI via Business Standard, 2015-12-03: "Spot gold fell to USD 1,045.85 an ounce, the lowest since February 2010 in earlier trade."',
    url: 'https://www.business-standard.com/amp/article/pti-stories/gold-crashes-to-3-1-2-month-low-global-melt-down-115120301164_1.html',
  },
  {
    year: 2020, kind: 'high', date: '2020-08-07', price: '2072.50',
    source: 'Reuters via BusinessDay, 2020-08-07: "Spot gold ... after hitting an all-time high of $2,072.50/oz in early trade."',
    url: 'https://www.businessday.co.za/bd/markets/2020-08-07-gold-hits-new-high-on-soaring-covid-19-cases/',
  },
];

// Spot quotes differ by venue; the larger of $5 and 0.3% of the price
export const GOLD_TOLERANCE_USD = 5;
export const GOLD_TOLERANCE_PCT = 0.3;

export interface GoldResult {
  extreme: GoldExtreme;
  ours: string | null;     // bid, USD
  oursAsk: string | null;
  oursTimeUtc: string | null;
  oursNyDay: string | null;
  diffUsd: number | null;
  toleranceUsd: number;
  ok: boolean;
  problems: string[];
}

// Our yearly extreme on the bid side (dealer spot quotes are bids): the highest
// bid_high or lowest bid_low of the UTC year, and its New York trading day
// (D1 sessions start at 17:00 NY the day before).
export async function compareGold(client: Client, extremes: readonly GoldExtreme[] = GOLD_EXTREMES):
  Promise<GoldResult[]> {
  if (extremes.length === 0) throw new Error('no gold extremes to compare');
  const results: GoldResult[] = [];
  for (const e of extremes) {
    const column = e.kind === 'high' ? 'bid_high' : 'bid_low';
    const askColumn = e.kind === 'high' ? 'ask_high' : 'ask_low';
    const { rows } = await client.query(`
      SELECT trim_scale(${column}::numeric / power(10::numeric, s.price_decimals))::text AS ours,
             trim_scale(${askColumn}::numeric / power(10::numeric, s.price_decimals))::text AS ours_ask,
             to_char(c.time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS utc,
             to_char((c.time AT TIME ZONE 'America/New_York') + INTERVAL '7 hours', 'YYYY-MM-DD') AS ny_day,
             (${column}::numeric / power(10::numeric, s.price_decimals) - $2::numeric)::float8 AS diff
      FROM historical_candles c JOIN historical_price_scale s ON s.pair = c.pair
      WHERE c.pair = 'XAU/USD' AND c.time >= make_timestamptz($1, 1, 1, 0, 0, 0, 'UTC')
        AND c.time < make_timestamptz($1 + 1, 1, 1, 0, 0, 0, 'UTC')
      ORDER BY ${column} ${e.kind === 'high' ? 'DESC' : 'ASC'}, c.time LIMIT 1
    `, [e.year, e.price]);
    const tolerance = Math.max(GOLD_TOLERANCE_USD, (Number(e.price) * GOLD_TOLERANCE_PCT) / 100);
    const row = rows[0];
    const problems: string[] = [];
    if (!row) problems.push(`no XAU/USD data in ${e.year}`);
    else {
      if (row.ny_day !== e.date) problems.push(`our ${e.year} ${e.kind} is on ${row.ny_day}, documented ${e.date}`);
      if (Math.abs(row.diff) > tolerance) problems.push(`differs by ${row.diff.toFixed(2)} USD (tolerance ${tolerance.toFixed(2)})`);
    }
    results.push({
      extreme: e, ours: row?.ours ?? null, oursAsk: row?.ours_ask ?? null, oursTimeUtc: row?.utc ?? null,
      oursNyDay: row?.ny_day ?? null, diffUsd: row?.diff ?? null, toleranceUsd: tolerance,
      ok: problems.length === 0, problems,
    });
  }
  return results;
}
