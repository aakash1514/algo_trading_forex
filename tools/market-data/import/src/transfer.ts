// Moves the imported history from one database to another (dev -> a fresh production database) as
// compressed CSV, rows only: historical_candles (one file per pair) and historical_import_log. Nothing
// else leaves: no users, live ticks, orders or backtests. historical_price_scale is created by the
// migrations, so it is only compared. The aggregates are rebuilt on the target from the minutes.
//
//   export  COPY each table out (ordered), gzip, sha256 each file, then manifest.json (written last:
//           its presence means a complete export). The manifest holds, per pair, the row count, the
//           first and last minute and the sum of every value column, computed by the source database.
//   check   compares a database with a manifest: the same fingerprint per pair, import log and price
//           scale. Fails on an empty or partial import, and on an empty manifest.
//   import  into a database whose history tables are empty: verifies every file's sha256 first, COPYs
//           the rows, compresses the chunks, refreshes the aggregates bottom-up (5m -> 15m -> 1h, then
//           4h -> 1d, the importer's own routine), VACUUM ANALYZE, then runs check.
//
// After an import, `npm run data:import -- --check-only` (rows per pair-year against the import log,
// aggregates against M1) and `npm run data:validate` (FRED and gold) check the copy independently.
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import type { Client } from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { refreshAggregates, vacuumAnalyze } from './aggregates';
import { CHECKS_WORK_MEM } from './checks';
import { compressChunks } from './importer';
import { yearRange } from './pairs';

export const MANIFEST = 'manifest.json';
const PAIR = /^[A-Z]{3}\/[A-Z]{3}$/;
const VALUE_COLUMNS = ['bid_open', 'bid_high', 'bid_low', 'bid_close', 'ask_open', 'ask_high', 'ask_low', 'ask_close',
  'bid_volume', 'ask_volume'] as const;

export interface PairFingerprint {
  pair: string;
  rows: string;
  first: string; // ISO minute
  last: string;
  sums: Record<string, string>; // per value column, exact (numeric as text)
}

export interface TransferFile {
  name: string;
  table: 'historical_candles' | 'historical_import_log';
  pair: string | null;
  rows: number;
  sha256: string;
}

export interface Manifest {
  format: 1;
  createdAt: string;
  candles: PairFingerprint[];
  importLogRows: number;
  priceScale: Record<string, unknown>[];
  files: TransferFile[];
}

async function columns(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`, [table]);
  if (rows.length === 0) throw new Error(`${table} has no columns (migrations not run?)`);
  return rows.map((r: { column_name: string }) => r.column_name);
}

export async function fingerprint(client: Client): Promise<PairFingerprint[]> {
  await client.query(`SET work_mem = '${CHECKS_WORK_MEM}'`);
  const sums = VALUE_COLUMNS.map((c) => `sum(${c})::numeric::text AS ${c}`).join(', ');
  const { rows } = await client.query(
    `SELECT pair, count(*)::bigint::text AS rows, min(time) AS first, max(time) AS last, ${sums}
     FROM historical_candles GROUP BY pair ORDER BY pair`);
  return rows.map((r: Record<string, string | Date>) => ({
    pair: r['pair'] as string,
    rows: r['rows'] as string,
    first: (r['first'] as Date).toISOString(),
    last: (r['last'] as Date).toISOString(),
    sums: Object.fromEntries(VALUE_COLUMNS.map((c) => [c, r[c] as string])),
  }));
}

async function importLogRows(client: Client): Promise<number> {
  return Number((await client.query('SELECT count(*)::int AS n FROM historical_import_log')).rows[0].n);
}

async function priceScale(client: Client): Promise<Record<string, unknown>[]> {
  const cols = await columns(client, 'historical_price_scale');
  return (await client.query(`SELECT ${cols.join(', ')} FROM historical_price_scale ORDER BY pair`)).rows;
}

// Counts the newline-terminated lines of a stream (the CSV's header + rows) as it passes
function lineCounter() {
  let lines = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      for (const byte of chunk) if (byte === 10) lines++;
      done(null, chunk);
    },
  });
  return { stream, lines: () => lines };
}

function hasher() {
  const hash = createHash('sha256');
  const stream = new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); done(null, chunk); } });
  return { stream, hex: () => hash.digest('hex') };
}

async function exportQuery(client: Client, sql: string, file: string): Promise<{ rows: number; sha256: string }> {
  const counter = lineCounter();
  const sha = hasher();
  await pipeline(client.query(copyTo(`COPY (${sql}) TO STDOUT WITH (FORMAT csv, HEADER true)`)), counter.stream,
    createGzip({ level: 6 }), sha.stream, createWriteStream(file));
  return { rows: counter.lines() - 1, sha256: sha.hex() };
}

export async function exportHistory(client: Client, dir: string, log: (line: string) => void = () => undefined): Promise<Manifest> {
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, MANIFEST))) throw new Error(`${dir} already holds an export (${MANIFEST}); use an empty directory`);
  const candles = await fingerprint(client);
  if (candles.length === 0) throw new Error('historical_candles is empty: nothing to export');
  const files: TransferFile[] = [];
  const candleCols = await columns(client, 'historical_candles');
  for (const fp of candles) {
    if (!PAIR.test(fp.pair)) throw new Error(`unexpected pair ${fp.pair}`);
    const name = `historical_candles_${fp.pair.replace('/', '')}.csv.gz`;
    // the pair is checked above and quoted: COPY (query) takes no bind parameters
    const result = await exportQuery(client,
      `SELECT ${candleCols.join(', ')} FROM historical_candles WHERE pair = '${fp.pair}' ORDER BY time`, join(dir, name));
    if (String(result.rows) !== fp.rows) throw new Error(`${name}: wrote ${result.rows} rows, the table has ${fp.rows}`);
    files.push({ name, table: 'historical_candles', pair: fp.pair, ...result });
    log(`${name}: ${result.rows} rows`);
  }
  const logCols = await columns(client, 'historical_import_log');
  const logFile = 'historical_import_log.csv.gz';
  const logResult = await exportQuery(client, `SELECT ${logCols.join(', ')} FROM historical_import_log ORDER BY pair, year`,
    join(dir, logFile));
  files.push({ name: logFile, table: 'historical_import_log', pair: null, ...logResult });
  log(`${logFile}: ${logResult.rows} rows`);

  const manifest: Manifest = {
    format: 1, createdAt: new Date().toISOString(), candles, importLogRows: logResult.rows,
    priceScale: await priceScale(client), files,
  };
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readManifest(dir: string): Manifest {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`${file} is missing: not a complete export`);
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (manifest.format !== 1) throw new Error(`unknown manifest format ${manifest.format}`);
  if (!manifest.candles?.length || !manifest.files?.length) throw new Error('the manifest lists no history');
  return manifest;
}

// Differences between a database and a manifest; empty means identical. Never empty for an empty
// manifest or an empty database.
export async function compareWithManifest(client: Client, manifest: Manifest): Promise<string[]> {
  const problems: string[] = [];
  if (manifest.candles.length === 0) problems.push('the manifest lists no pairs');
  const actual = new Map((await fingerprint(client)).map((f) => [f.pair, f]));
  if (actual.size === 0) problems.push('historical_candles is empty');
  for (const expected of manifest.candles) {
    const got = actual.get(expected.pair);
    if (!got) {
      problems.push(`${expected.pair}: missing (${expected.rows} rows expected)`);
      continue;
    }
    for (const key of ['rows', 'first', 'last'] as const) {
      if (got[key] !== expected[key]) problems.push(`${expected.pair}: ${key} ${got[key]}, expected ${expected[key]}`);
    }
    for (const col of VALUE_COLUMNS) {
      if (got.sums[col] !== expected.sums[col]) problems.push(`${expected.pair}: sum(${col}) differs`);
    }
    actual.delete(expected.pair);
  }
  for (const extra of actual.keys()) problems.push(`${extra}: not in the manifest`);
  const logRows = await importLogRows(client);
  if (logRows !== manifest.importLogRows) problems.push(`historical_import_log: ${logRows} rows, expected ${manifest.importLogRows}`);
  if (JSON.stringify(await priceScale(client)) !== JSON.stringify(manifest.priceScale)) {
    problems.push('historical_price_scale differs from the source');
  }
  return problems;
}

async function fileSha256(file: string): Promise<string> {
  const sha = hasher();
  await pipeline(createReadStream(file), sha.stream, new Writable({ write: (_chunk, _enc, done) => done() }));
  return sha.hex();
}

export interface ImportSummary {
  rows: number;
  refreshSteps: number;
  problems: string[];
}

export async function importHistory(client: Client, dir: string, log: (line: string) => void = () => undefined): Promise<ImportSummary> {
  const manifest = readManifest(dir);
  // every file present and intact before anything is written
  for (const f of manifest.files) {
    const file = join(dir, f.name);
    if (!existsSync(file)) throw new Error(`${f.name} is missing: partial export, nothing imported`);
    if ((await fileSha256(file)) !== f.sha256) throw new Error(`${f.name}: sha256 differs from the manifest, nothing imported`);
  }
  const existing = Number((await client.query(
    `SELECT (SELECT count(*) FROM (SELECT 1 FROM historical_candles LIMIT 1) c)
          + (SELECT count(*) FROM historical_import_log) AS n`)).rows[0].n);
  if (existing > 0) throw new Error('the target already holds history: import only into an empty database');
  if (JSON.stringify(await priceScale(client)) !== JSON.stringify(manifest.priceScale)) {
    throw new Error('historical_price_scale on the target differs from the source (migrations out of step?)');
  }

  let rows = 0;
  for (const f of manifest.files) {
    const cols = await columns(client, f.table);
    const counter = lineCounter();
    await pipeline(createReadStream(join(dir, f.name)), createGunzip(), counter.stream,
      client.query(copyFrom(`COPY ${f.table} (${cols.join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER MATCH)`)));
    if (counter.lines() - 1 !== f.rows) throw new Error(`${f.name}: read ${counter.lines() - 1} rows, the manifest says ${f.rows}`);
    rows += f.rows;
    log(`${f.name}: ${f.rows} rows`);
  }

  log('compressing historical_candles chunks');
  await compressChunks(client, 'historical_candles');
  const years = (await client.query('SELECT DISTINCT year FROM historical_import_log ORDER BY year')).rows
    .map((r: { year: number }) => r.year);
  const steps = await refreshAggregates(client, years.map(yearRange),
    (s) => log(`refreshed ${s.view} ${s.window.start.toISOString().slice(0, 10)}..${s.window.end.toISOString().slice(0, 10)} (${s.seconds.toFixed(0)} s)`));
  await vacuumAnalyze(client);
  return { rows, refreshSteps: steps.length, problems: await compareWithManifest(client, manifest) };
}
