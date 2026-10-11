// Loads one pair's M1 file for one period (a year in production) into
// historical_candles, in a single transaction together with its import-log row.
//
//   1. sha256 of the file; skip if the log already has the same hash for this
//      pair-year, stop if it has a different one (unless forced).
//   2. Header check, then COPY into a temporary staging table (temporary tables
//      skip the WAL, like an unlogged table, and drop at commit/rollback).
//   3. Validation in SQL on the staged rows: exactly one row per minute of the
//      period (first row = period start, 1-minute steps, row count), no nulls,
//      every price a whole number of points and every volume a whole number of
//      millionths at the pair's fixed scale. Any failure rolls back.
//   4. Decompress chunks overlapping the period, delete the pair's rows in it
//      when forced, INSERT ... SELECT the minutes where bid or ask volume > 0,
//      converting text -> numeric -> integer in SQL (never through a JS float).
//   5. Insert (or, when forced, replace) the import-log row; commit.
//
// A plain INSERT, not ON CONFLICT DO NOTHING: it measured 3.6x faster, the log
// decides what gets loaded, and a duplicate minute is a loud PK violation
// instead of a silently skipped row.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Client } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { MINUTE_MS, type TimeRange } from './pairs';

export const EXPECTED_HEADER =
  'time_ms,bid_open,bid_high,bid_low,bid_close,bid_volume,ask_open,ask_high,ask_low,ask_close,ask_volume';

const PRICE_COLUMNS = ['bid_open', 'bid_high', 'bid_low', 'bid_close', 'ask_open', 'ask_high', 'ask_low', 'ask_close'];
const VOLUME_COLUMNS = ['bid_volume', 'ask_volume'];
// Staging columns in file order; names match the header (COPY ... HEADER MATCH checks it too)
const STAGING_COLUMNS = EXPECTED_HEADER.split(',');

export class ImportError extends Error {}

export interface ImportRequest {
  symbol: string;   // EURUSD
  pair: string;     // EUR/USD
  year: number;     // import-log key
  file: string;     // absolute path
  sourceFile: string; // as recorded in the log (repo-relative)
  range: TimeRange; // the period the file must cover exactly (the year, in production)
  force?: boolean;
  dryRun?: boolean;
}

export type ImportOutcome = 'imported' | 'replaced' | 'skipped' | 'validated';

export interface ImportResult {
  outcome: ImportOutcome;
  sha256: string;
  sourceRows: number;
  importedRows: number;
  decompressedChunks: number;
  seconds: number;
}

export interface Scale {
  priceDecimals: number;
  volumeDecimals: number;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export async function readHeader(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0];
  } finally {
    await handle.close();
  }
}

export async function loadScale(client: Client, pair: string): Promise<Scale> {
  const { rows } = await client.query(
    'SELECT price_decimals, volume_decimals FROM historical_price_scale WHERE pair = $1', [pair]);
  if (rows.length === 0) throw new ImportError(`${pair} has no historical_price_scale row`);
  return { priceDecimals: rows[0].price_decimals, volumeDecimals: rows[0].volume_decimals };
}

// Compressed chunks of a hypertable overlapping a time range, as regclass text.
async function compressedChunks(client: Client, hypertable: string, range: TimeRange): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
     FROM timescaledb_information.chunks
     WHERE hypertable_name = $1 AND is_compressed AND range_start < $3 AND range_end > $2
     ORDER BY range_start`,
    [hypertable, range.start, range.end]);
  return rows.map((r) => r.chunk);
}

export async function decompressOverlapping(client: Client, hypertable: string, range: TimeRange): Promise<number> {
  const chunks = await compressedChunks(client, hypertable, range);
  for (const chunk of chunks) {
    await client.query('SELECT decompress_chunk($1::regclass, if_compressed => true)', [chunk]);
  }
  return chunks.length;
}

// Compresses the uncompressed chunks of a hypertable that end at or before `before`
// (all of them when it is omitted). Returns how many were compressed.
export async function compressChunks(client: Client, hypertable: string, before?: Date): Promise<number> {
  const { rows } = await client.query(
    `SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
     FROM timescaledb_information.chunks
     WHERE hypertable_name = $1 AND NOT is_compressed AND ($2::timestamptz IS NULL OR range_end <= $2)
     ORDER BY range_start`,
    [hypertable, before ?? null]);
  for (const { chunk } of rows) {
    await client.query('SELECT compress_chunk($1::regclass, if_not_compressed => true)', [chunk]);
  }
  return rows.length;
}

interface StagedStats {
  rows: number;
  first_ms: string;
  last_ms: string;
  distinct_minutes: number;
  misaligned: number;
  nulls: number;
  inexact_prices: number;
  inexact_volumes: number;
}

// Whole-number test at a scale, in numeric arithmetic: x * 10^d = trunc(x * 10^d)
const whole = (column: string, factor: string) => `(${column} * ${factor} = trunc(${column} * ${factor}))`;

async function validateStaged(client: Client, req: ImportRequest, scale: Scale): Promise<number> {
  const priceFactor = `${10 ** scale.priceDecimals}::numeric`;
  const volumeFactor = `${10 ** scale.volumeDecimals}::numeric`;
  const { rows: [s] } = await client.query<StagedStats>(`
    SELECT count(*)::int AS rows,
           min(time_ms)::text AS first_ms,
           max(time_ms)::text AS last_ms,
           count(DISTINCT time_ms)::int AS distinct_minutes,
           count(*) FILTER (WHERE time_ms % ${MINUTE_MS} <> 0)::int AS misaligned,
           count(*) FILTER (WHERE num_nulls(${STAGING_COLUMNS.join(', ')}) > 0)::int AS nulls,
           count(*) FILTER (WHERE NOT (${PRICE_COLUMNS.map((c) => whole(c, priceFactor)).join(' AND ')}))::int
             AS inexact_prices,
           count(*) FILTER (WHERE NOT (${VOLUME_COLUMNS.map((c) => whole(c, volumeFactor)).join(' AND ')}))::int
             AS inexact_volumes
    FROM historical_staging
  `);

  const startMs = req.range.start.getTime();
  const endMs = req.range.end.getTime();
  const expected = (endMs - startMs) / MINUTE_MS;
  const where = `${req.symbol} ${req.year} (${req.sourceFile})`;
  const fail = (why: string) => { throw new ImportError(`${where}: ${why}; nothing was imported`); };

  if (s.rows !== expected) fail(`${s.rows} rows, expected ${expected} (one per minute of the period)`);
  if (s.nulls > 0) fail(`${s.nulls} rows with empty fields`);
  if (Number(s.first_ms) !== startMs) fail(`first row is ${iso(s.first_ms)}, expected ${req.range.start.toISOString()}`);
  if (Number(s.last_ms) !== endMs - MINUTE_MS) {
    fail(`last row is ${iso(s.last_ms)}, expected ${new Date(endMs - MINUTE_MS).toISOString()}`);
  }
  if (s.misaligned > 0) fail(`${s.misaligned} rows not on a whole minute`);
  // Same count as minutes, first/last on the bounds, all aligned and distinct
  // => exactly one row per minute, in 1-minute steps.
  if (s.distinct_minutes !== s.rows) fail(`${s.rows - s.distinct_minutes} duplicate minutes`);
  if (s.inexact_prices > 0) {
    fail(`${s.inexact_prices} rows have a price that is not a whole number at ${scale.priceDecimals} decimals ` +
      `(first: ${await firstInexact(client, PRICE_COLUMNS, priceFactor)}); refusing to round`);
  }
  if (s.inexact_volumes > 0) {
    fail(`${s.inexact_volumes} rows have a volume that is not a whole number at ${scale.volumeDecimals} decimals ` +
      `(first: ${await firstInexact(client, VOLUME_COLUMNS, volumeFactor)}); refusing to round`);
  }
  return s.rows;
}

async function firstInexact(client: Client, columns: string[], factor: string): Promise<string> {
  const { rows } = await client.query(`
    SELECT time_ms::text, ${columns.map((c) => `${c}::text`).join(', ')}
    FROM historical_staging
    WHERE NOT (${columns.map((c) => whole(c, factor)).join(' AND ')})
    ORDER BY time_ms LIMIT 1
  `);
  const row = rows[0];
  return `${iso(row.time_ms)} ${columns.map((c) => `${c}=${row[c]}`).join(' ')}`;
}

function iso(ms: string): string {
  return new Date(Number(ms)).toISOString();
}

export async function importPairRange(client: Client, req: ImportRequest): Promise<ImportResult> {
  const started = Date.now();
  const header = await readHeader(req.file);
  if (header !== EXPECTED_HEADER) {
    throw new ImportError(`${req.sourceFile}: unexpected header "${header}"`);
  }
  const sha256 = await sha256File(req.file);

  const { rows: logged } = await client.query(
    'SELECT source_sha256 FROM historical_import_log WHERE pair = $1 AND year = $2', [req.pair, req.year]);
  const previous: string | undefined = logged[0]?.source_sha256;
  if (previous !== undefined && !req.force) {
    if (previous === sha256) {
      return { outcome: 'skipped', sha256, sourceRows: 0, importedRows: 0, decompressedChunks: 0, seconds: secs(started) };
    }
    throw new ImportError(`${req.symbol} ${req.year}: ${req.sourceFile} changed since it was imported ` +
      `(log ${previous.slice(0, 12)}…, file ${sha256.slice(0, 12)}…); re-import with --force ${req.symbol}:${req.year}`);
  }

  const scale = await loadScale(client, req.pair);
  const priceFactor = `${10 ** scale.priceDecimals}::numeric`;
  const volumeFactor = `${10 ** scale.volumeDecimals}::numeric`;

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TEMPORARY TABLE historical_staging (
        time_ms bigint,
        ${STAGING_COLUMNS.slice(1).map((c) => `${c} numeric`).join(', ')}
      ) ON COMMIT DROP
    `);
    // The bytes COPY reads are hashed again, so the logged hash is the hash of
    // exactly what was loaded (the file can't change between the two reads unnoticed).
    const copied = createHash('sha256');
    await pipeline(
      createReadStream(req.file),
      new Transform({ transform(chunk, _encoding, done) { copied.update(chunk); done(null, chunk); } }),
      client.query(copyFrom('COPY historical_staging FROM STDIN WITH (FORMAT csv, HEADER MATCH)')),
    );
    if (copied.digest('hex') !== sha256) throw new ImportError(`${req.sourceFile} changed while it was being imported`);
    const sourceRows = await validateStaged(client, req, scale);

    // Writes go to uncompressed chunks: a forced re-import, or a year whose
    // boundary chunk was compressed with the neighbouring year.
    const decompressedChunks = await decompressOverlapping(client, 'historical_candles', req.range);
    if (req.force) {
      await client.query('DELETE FROM historical_candles WHERE pair = $1 AND time >= $2 AND time < $3',
        [req.pair, req.range.start, req.range.end]);
    }

    // The validation above proved every value is whole at the scale, so the
    // numeric -> integer casts below never round.
    const inserted = await client.query(`
      INSERT INTO historical_candles (time, pair, ${[...PRICE_COLUMNS, ...VOLUME_COLUMNS].join(', ')})
      SELECT timestamptz 'epoch' + (time_ms / ${MINUTE_MS}) * INTERVAL '1 minute', $1,
             ${PRICE_COLUMNS.map((c) => `(${c} * ${priceFactor})::integer`).join(', ')},
             ${VOLUME_COLUMNS.map((c) => `(${c} * ${volumeFactor})::bigint`).join(', ')}
      FROM historical_staging
      WHERE bid_volume > 0 OR ask_volume > 0
      ORDER BY time_ms
    `, [req.pair]);
    const importedRows = inserted.rowCount ?? 0;
    if (importedRows === 0) throw new ImportError(`${req.symbol} ${req.year}: no minute with volume; nothing was imported`);

    await client.query(`
      INSERT INTO historical_import_log
        (pair, year, source_file, source_sha256, source_rows, imported_rows, first_time, last_time,
         price_decimals, volume_decimals)
      SELECT $1::varchar, $2::smallint, $3::text, $4::char(64), $5::integer, $6::integer, min(time), max(time),
             $7::smallint, $8::smallint
      FROM historical_candles WHERE pair = $1::varchar AND time >= $9::timestamptz AND time < $10::timestamptz
      ${req.force ? `ON CONFLICT (pair, year) DO UPDATE SET
        source_file = EXCLUDED.source_file, source_sha256 = EXCLUDED.source_sha256,
        source_rows = EXCLUDED.source_rows, imported_rows = EXCLUDED.imported_rows,
        first_time = EXCLUDED.first_time, last_time = EXCLUDED.last_time,
        price_decimals = EXCLUDED.price_decimals, volume_decimals = EXCLUDED.volume_decimals,
        imported_at = now()` : ''}
    `, [req.pair, req.year, req.sourceFile, sha256, sourceRows, importedRows,
      scale.priceDecimals, scale.volumeDecimals, req.range.start, req.range.end]);

    await client.query(req.dryRun ? 'ROLLBACK' : 'COMMIT');
    const outcome: ImportOutcome = req.dryRun ? 'validated' : previous !== undefined ? 'replaced' : 'imported';
    return { outcome, sha256, sourceRows, importedRows, decompressedChunks, seconds: secs(started) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

function secs(since: number): number {
  return (Date.now() - since) / 1000;
}
