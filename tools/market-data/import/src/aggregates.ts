// Refreshes the historical continuous aggregates after an import.
//
// refresh_continuous_aggregate only materializes buckets that lie entirely inside
// the window. That is harmless for the UTC aggregates (5m/15m/1h): every bucket
// sits inside one UTC day, so per-range windows widened to whole days lose
// nothing. The New York aggregates (4h/1d) are different: their bars start at
// 17:00 NY (21:00/22:00 UTC), so the bar that holds the evening of Dec 31 crosses
// the UTC year boundary and is never fully inside a yearly window (real case:
// EUR/USD traded 22:00-24:00 UTC on 2012-12-31). They are refreshed once, over
// one window spanning every touched range, padded a week on each side.
//
// Order: 5m -> 15m -> 1h (each built on the previous), then 4h (from M1) -> 1d
// (from 4h). 5m and 15m are columnstore: their chunks in the windows are
// decompressed first and everything is compressed once at the end.
import type { Client } from 'pg';
import { compressChunks, decompressOverlapping } from './importer';
import type { TimeRange } from './pairs';

const DAY_MS = 86_400_000;
export const NY_PADDING_MS = 7 * DAY_MS;

export const UTC_VIEWS = ['historical_candles_5m', 'historical_candles_15m', 'historical_candles_1h'] as const;
export const NY_VIEWS = ['historical_candles_4h', 'historical_candles_1d'] as const;
export const COLUMNSTORE_VIEWS = ['historical_candles_5m', 'historical_candles_15m'] as const;

export interface RefreshStep {
  view: string;
  window: TimeRange;
  seconds: number;
}

// Whole UTC days covering each range. Overlapping windows are merged; adjacent
// ones (consecutive years) stay separate, so each refresh handles at most a year.
export function utcWindows(ranges: TimeRange[]): TimeRange[] {
  const days = ranges
    .map((r) => ({
      start: Math.floor(r.start.getTime() / DAY_MS) * DAY_MS,
      end: Math.ceil(r.end.getTime() / DAY_MS) * DAY_MS,
    }))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const d of days) {
    const last = merged[merged.length - 1];
    if (last && d.start < last.end) last.end = Math.max(last.end, d.end);
    else merged.push({ ...d });
  }
  return merged.map((m) => ({ start: new Date(m.start), end: new Date(m.end) }));
}

// One window over every range, padded so every NY bar touching them is inside.
export function newYorkWindow(ranges: TimeRange[]): TimeRange {
  const start = Math.min(...ranges.map((r) => r.start.getTime())) - NY_PADDING_MS;
  const end = Math.max(...ranges.map((r) => r.end.getTime())) + NY_PADDING_MS;
  return { start: new Date(start), end: new Date(end) };
}

async function materializationHypertable(client: Client, view: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT materialization_hypertable_name AS name FROM timescaledb_information.continuous_aggregates
     WHERE view_name = $1`, [view]);
  if (rows.length === 0) throw new Error(`${view} is not a continuous aggregate`);
  return rows[0].name;
}

export async function refreshAggregates(
  client: Client,
  ranges: TimeRange[],
  log: (step: RefreshStep) => void = () => undefined,
): Promise<RefreshStep[]> {
  if (ranges.length === 0) return [];
  const utc = utcWindows(ranges);
  const ny = newYorkWindow(ranges);
  const steps: RefreshStep[] = [];

  const materialization = new Map<string, string>();
  for (const view of COLUMNSTORE_VIEWS) {
    const hypertable = await materializationHypertable(client, view);
    materialization.set(view, hypertable);
    for (const window of utc) await decompressOverlapping(client, hypertable, window);
  }

  const refresh = async (view: string, window: TimeRange) => {
    const started = Date.now();
    // CALL can't take bind parameters for "any" arguments; the window is built
    // from Dates, never from user text.
    await client.query(`CALL refresh_continuous_aggregate('${view}', ` +
      `'${window.start.toISOString()}'::timestamptz, '${window.end.toISOString()}'::timestamptz)`);
    const step = { view, window, seconds: (Date.now() - started) / 1000 };
    steps.push(step);
    log(step);
  };

  for (const view of UTC_VIEWS) {
    for (const window of utc) await refresh(view, window);
  }
  for (const view of NY_VIEWS) await refresh(view, ny);

  for (const view of COLUMNSTORE_VIEWS) {
    await compressChunks(client, materialization.get(view) as string);
  }
  return steps;
}

// After a bulk load: reclaims the dead tuples left by forced re-imports and
// aggregate rewrites, and gives the planner statistics for the new rows.
// VACUUM on a hypertable recurses into its chunks; it can't run in a transaction.
export async function vacuumAnalyze(client: Client): Promise<number> {
  const started = Date.now();
  const targets = ['historical_candles'];
  for (const view of [...UTC_VIEWS, ...NY_VIEWS]) {
    const { rows } = await client.query(
      `SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name) AS name
       FROM timescaledb_information.continuous_aggregates WHERE view_name = $1`, [view]);
    targets.push(rows[0].name);
  }
  // Names come from the catalog, not from user input
  await client.query(`VACUUM (ANALYZE) ${targets.join(', ')}`);
  return (Date.now() - started) / 1000;
}
