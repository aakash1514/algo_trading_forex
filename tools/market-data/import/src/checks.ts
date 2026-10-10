// Real-data checks after an import. Each one recomputes from M1 or compares
// against the import log, independently of the aggregate definitions in the
// migration (a wrong definition must not be able to confirm itself).
//
//   1. Rows and first/last minute per pair-year equal the import log.
//   2. Every import-log row uses its pair's fixed scale.
//   3. sum(minutes) of every aggregate equals the M1 row count, per pair.
//   4. H1, H4 and D1 recomputed from M1 equal the stored aggregates, bar for bar.
//   5. Around every year boundary (Jan 1 +- 7 days) no H4/D1 bar is missing or different.
//   6. D1 weekly shape: at most 5 bars with >= 60 minutes per pair and New York
//      week; stubs (< 60 minutes) exactly the named ones in stubs.ts.
//   7. Storage: compression ratio of M1, aggregate sizes.
import type { Client } from 'pg';
import { NY_VIEWS, UTC_VIEWS } from './aggregates';
import { evaluateStubs, type Coverage, type Stub } from './stubs';

export const CHECKS_WORK_MEM = '256MB';

export interface CheckResult {
  name: string;
  ok: boolean;
  lines: string[];
}


const NY_BUCKET = (width: string, column: string) =>
  `time_bucket(INTERVAL '${width}', ${column}, 'America/New_York', origin => '2000-01-02 22:00:00+00')`;

const VALUE_COLUMNS = ['bid_open', 'bid_high', 'bid_low', 'bid_close', 'ask_open', 'ask_high', 'ask_low', 'ask_close',
  'bid_volume', 'ask_volume', 'minutes'];

const OHLC_FROM_M1 = `
  first(bid_open, time) AS bid_open, max(bid_high) AS bid_high, min(bid_low) AS bid_low, last(bid_close, time) AS bid_close,
  first(ask_open, time) AS ask_open, max(ask_high) AS ask_high, min(ask_low) AS ask_low, last(ask_close, time) AS ask_close,
  sum(bid_volume)::bigint AS bid_volume, sum(ask_volume)::bigint AS ask_volume, count(*)::int AS minutes`;

interface Comparison {
  stored: number;
  recomputed: number;
  only_stored: number;
  only_recomputed: number;
  different: number;
}

// Compares an aggregate with the same bars rebuilt from M1. With a window, only
// bars starting inside it are compared (M1 is read a day beyond each side so
// those bars are complete).
async function compareWithM1(client: Client, view: string, bucket: string, window?: { start: Date; end: Date }):
  Promise<Comparison> {
  const params = window ? [window.start, window.end] : [];
  const m1Filter = window ? `WHERE time >= $1::timestamptz - INTERVAL '1 day' AND time < $2::timestamptz + INTERVAL '1 day'` : '';
  const barFilter = window ? 'WHERE bucket >= $1 AND bucket < $2' : '';
  const cols = (alias: string) => `(${VALUE_COLUMNS.map((c) => `${alias}.${c}`).join(', ')})`;
  const { rows: [c] } = await client.query<Comparison>(`
    WITH r AS (
      SELECT * FROM (
        SELECT ${bucket} AS bucket, pair, ${OHLC_FROM_M1} FROM historical_candles ${m1Filter} GROUP BY 1, 2
      ) rebuilt ${barFilter}
    ), s AS (
      SELECT bucket, pair, ${VALUE_COLUMNS.join(', ')} FROM ${view} ${barFilter}
    )
    SELECT count(s.pair)::int AS stored,
           count(r.pair)::int AS recomputed,
           count(*) FILTER (WHERE r.pair IS NULL)::int AS only_stored,
           count(*) FILTER (WHERE s.pair IS NULL)::int AS only_recomputed,
           count(*) FILTER (WHERE r.pair IS NOT NULL AND s.pair IS NOT NULL AND ${cols('r')} IS DISTINCT FROM ${cols('s')})::int
             AS different
    FROM r FULL JOIN s ON s.bucket = r.bucket AND s.pair = r.pair
  `, params);
  return c;
}

const matches = (c: Comparison) => c.only_stored === 0 && c.only_recomputed === 0 && c.different === 0;
const describe = (c: Comparison) =>
  `${c.stored} stored, ${c.recomputed} rebuilt from M1, ${c.only_stored} only stored, ` +
  `${c.only_recomputed} missing, ${c.different} different`;

async function checkImportLog(client: Client): Promise<CheckResult> {
  const { rows } = await client.query(`
    WITH t AS (
      SELECT pair, extract(year FROM time AT TIME ZONE 'UTC')::int AS year,
             count(*)::int AS n, min(time) AS first_time, max(time) AS last_time
      FROM historical_candles GROUP BY 1, 2
    )
    SELECT coalesce(t.pair, l.pair) AS pair, coalesce(t.year, l.year) AS year,
           t.n AS table_rows, l.imported_rows AS log_rows,
           t.first_time = l.first_time AND t.last_time = l.last_time AS bounds_match
    FROM t FULL JOIN historical_import_log l ON l.pair = t.pair AND l.year = t.year
    ORDER BY 1, 2
  `);
  const bad = rows.filter((r) => r.table_rows !== r.log_rows || !r.bounds_match);
  const total = rows.reduce((sum, r) => sum + (r.table_rows ?? 0), 0);
  return {
    name: 'Rows per pair-year equal the import log',
    ok: rows.length > 0 && bad.length === 0,
    lines: [`${rows.length} pair-years, ${total.toLocaleString('en-US')} M1 rows`,
      ...bad.map((r) => `MISMATCH ${r.pair} ${r.year}: table ${r.table_rows}, log ${r.log_rows}, bounds match ${r.bounds_match}`)],
  };
}

async function checkScale(client: Client): Promise<CheckResult> {
  const { rows } = await client.query(`
    SELECT l.pair, s.price_decimals, s.volume_decimals,
           count(*)::int AS years,
           count(*) FILTER (WHERE (l.price_decimals, l.volume_decimals) IS DISTINCT FROM (s.price_decimals, s.volume_decimals))::int AS off_scale
    FROM historical_import_log l LEFT JOIN historical_price_scale s ON s.pair = l.pair
    GROUP BY 1, 2, 3 ORDER BY 1
  `);
  return {
    name: 'One fixed scale per pair',
    ok: rows.every((r) => r.off_scale === 0 && r.price_decimals !== null),
    lines: rows.map((r) => `${r.pair}: prices ${r.price_decimals} dp, volumes ${r.volume_decimals} dp, ` +
      `${r.years} pair-years, ${r.off_scale} off scale`),
  };
}

async function checkMinuteTotals(client: Client): Promise<CheckResult> {
  const lines: string[] = [];
  let ok = true;
  const { rows: m1 } = await client.query(`SELECT pair, count(*)::bigint::text AS n FROM historical_candles GROUP BY 1 ORDER BY 1`);
  for (const view of [...UTC_VIEWS, ...NY_VIEWS]) {
    const { rows } = await client.query(`SELECT pair, sum(minutes)::bigint::text AS n FROM ${view} GROUP BY 1`);
    const byPair = new Map(rows.map((r) => [r.pair, r.n]));
    const off = m1.filter((r) => byPair.get(r.pair) !== r.n);
    if (off.length > 0 || rows.length !== m1.length) ok = false;
    lines.push(`${view}: ${off.length === 0 && rows.length === m1.length ? 'equal' : 'DIFFERENT'} ` +
      `(${m1.map((r) => `${r.pair} ${byPair.get(r.pair) ?? 0}/${r.n}`).join(', ')})`);
  }
  return { name: 'sum(minutes) of every aggregate = M1 rows per pair', ok, lines };
}

async function checkRebuilt(client: Client): Promise<CheckResult> {
  const lines: string[] = [];
  let ok = true;
  for (const [view, bucket] of [
    ['historical_candles_1h', `time_bucket(INTERVAL '1 hour', time)`],
    ['historical_candles_4h', NY_BUCKET('4 hours', 'time')],
    ['historical_candles_1d', NY_BUCKET('1 day', 'time')],
  ]) {
    const c = await compareWithM1(client, view, bucket);
    if (!matches(c) || c.stored === 0) ok = false;
    lines.push(`${view}: ${describe(c)}`);
  }
  return { name: 'H1, H4 and D1 rebuilt from M1 equal the aggregates', ok, lines };
}

async function checkYearBoundaries(client: Client): Promise<CheckResult> {
  const { rows: [span] } = await client.query(
    'SELECT min(year)::int AS first, max(year)::int AS last FROM historical_import_log');
  const lines: string[] = [];
  let ok = span.first !== null;
  for (let year = span.first; span.first !== null && year <= span.last + 1; year++) {
    const jan1 = Date.UTC(year, 0, 1);
    const window = { start: new Date(jan1 - 7 * 86_400_000), end: new Date(jan1 + 7 * 86_400_000) };
    const parts: string[] = [];
    for (const [view, bucket] of [
      ['historical_candles_4h', NY_BUCKET('4 hours', 'time')],
      ['historical_candles_1d', NY_BUCKET('1 day', 'time')],
    ]) {
      const c = await compareWithM1(client, view, bucket, window);
      if (!matches(c)) ok = false;
      parts.push(`${view.replace('historical_candles_', '')} ${c.stored}/${c.recomputed}` +
        (matches(c) ? '' : ` (${c.only_recomputed} missing, ${c.different} different, ${c.only_stored} extra)`));
    }
    lines.push(`${year - 1}/${year}: ${parts.join(', ')}`);
  }
  return { name: 'No missing or different H4/D1 bars around each Jan 1 (+-7 days)', ok, lines };
}

async function checkWeeklyShape(client: Client): Promise<CheckResult> {
  const week = NY_BUCKET('7 days', 'bucket');
  const { rows: weeks } = await client.query(`
    SELECT pair, full_bars, count(*)::int AS weeks
    FROM (SELECT pair, ${week} AS week, count(*) FILTER (WHERE minutes >= 60)::int AS full_bars
          FROM historical_candles_1d GROUP BY 1, 2) w
    GROUP BY 1, 2 ORDER BY 1, 2
  `);
  const { rows: stubs } = await client.query<Stub>(`
    SELECT pair, to_char(bucket AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS "nyStart", minutes
    FROM historical_candles_1d WHERE minutes < 60 ORDER BY bucket, pair
  `);
  const { rows: coverage } = await client.query<Coverage>(`
    SELECT pair, to_char(first_time AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS "firstDate",
           to_char(last_time AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS "lastDate"
    FROM historical_import_log
  `);
  const stubCheck = evaluateStubs(stubs, coverage);
  const tooMany = weeks.filter((w) => w.full_bars > 5);
  const lines = [
    'Weeks by number of full D1 bars (>= 60 minutes); weeks under 5 are holiday weeks:',
    ...[...new Set(weeks.map((w) => w.pair))].map((pair) => `  ${pair}: ` +
      weeks.filter((w) => w.pair === pair).map((w) => `${w.full_bars} bars x ${w.weeks}`).join(', ')),
    ...stubCheck.lines,
    ...tooMany.map((w) => `MORE THAN 5 FULL BARS: ${w.pair}, ${w.weeks} week(s) with ${w.full_bars}`),
  ];
  return {
    name: 'D1 weekly shape: at most 5 full bars per week; stubs exactly the named Sunday and holiday ones',
    ok: weeks.length > 0 && tooMany.length === 0 && stubCheck.ok,
    lines,
  };
}

function mb(bytes: number | string | null): string {
  return `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`;
}

async function storage(client: Client): Promise<CheckResult> {
  const { rows: [m1] } = await client.query(`
    SELECT total_chunks, number_compressed_chunks,
           before_compression_total_bytes::text AS before, after_compression_total_bytes::text AS after,
           hypertable_size('historical_candles')::text AS size
    FROM hypertable_columnstore_stats('historical_candles')
  `);
  const ratio = Number(m1.after) > 0 ? Number(m1.before) / Number(m1.after) : 0;
  const lines = [
    `historical_candles: ${mb(m1.size)} on disk, ${m1.number_compressed_chunks}/${m1.total_chunks} chunks compressed, ` +
      `${mb(m1.before)} -> ${mb(m1.after)} (${ratio.toFixed(1)}x)`,
  ];
  for (const view of [...UTC_VIEWS, ...NY_VIEWS]) {
    const { rows: [v] } = await client.query(`
      SELECT (SELECT count(*) FROM ${view})::int AS bars,
             hypertable_size(format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass)::text AS size
      FROM timescaledb_information.continuous_aggregates WHERE view_name = $1
    `, [view]);
    lines.push(`${view}: ${v.bars.toLocaleString('en-US')} bars, ${mb(v.size)}`);
  }
  const { rows: [db] } = await client.query('SELECT pg_database_size(current_database())::text AS size');
  lines.push(`database total: ${mb(db.size)}`);
  return { name: 'Storage', ok: true, lines };
}

export async function runChecks(client: Client, log: (r: CheckResult, seconds: number) => void = () => undefined):
  Promise<CheckResult[]> {
  // Rebuilding H1/H4/D1 from 19M M1 rows groups ~400k bars. At the default 4 MB
  // work_mem those aggregations spilled ~6 GB of temp files per run (measured),
  // which also grew Docker's virtual disk. Raised for this session only.
  await client.query(`SET work_mem = '${CHECKS_WORK_MEM}'`);
  const results: CheckResult[] = [];
  try {
    for (const check of [checkImportLog, checkScale, checkMinuteTotals, checkRebuilt, checkYearBoundaries,
      checkWeeklyShape, storage]) {
      const started = Date.now();
      const result = await check(client);
      results.push(result);
      log(result, (Date.now() - started) / 1000);
    }
  } finally {
    await client.query('RESET work_mem');
  }
  return results;
}
