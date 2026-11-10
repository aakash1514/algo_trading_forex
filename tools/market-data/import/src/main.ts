// Imports the Dukascopy M1 exports (data/raw/jforex/<SYMBOL>/<YEAR>.csv) into
// historical_candles, refreshes the aggregates and runs the real-data checks.
//
//   npm run data:import -- [--years 2010-2022] [--pairs EURUSD,...] [--force EURUSD:2022] [--dry-run]
//   npm run data:import -- --check-only
//
// Year-major: all pairs of a year, then the year's finished chunks are
// compressed (the chunk straddling into the next year waits for it). After the
// last year: remaining chunks compressed, aggregates refreshed (see
// aggregates.ts), 5m/15m compressed, M1 and aggregates vacuumed, checks run. Safe to re-run: pair-years
// already in the import log with the same file hash are skipped.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Client } from 'pg';
import { forceKey, parseArgs, USAGE, UsageError, type ImportArgs } from './args';
import { refreshAggregates, vacuumAnalyze } from './aggregates';
import { CHECKS_WORK_MEM, runChecks } from './checks';
import { compressChunks, ImportError, importPairRange, type ImportResult } from './importer';
import { PAIRS, yearRange, type TimeRange } from './pairs';

const REPO_ROOT = join(__dirname, '../../../..');
const DATA_DIR = join(REPO_ROOT, 'data/raw/jforex');
// One importer at a time (a second run would race on the same chunks)
const ADVISORY_LOCK = 'forexedge:historical-import';

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

function fmt(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${Math.round(seconds % 60).toString().padStart(2, '0')}s`
    : `${seconds.toFixed(1)}s`;
}

async function importAll(client: Client, args: ImportArgs): Promise<TimeRange[]> {
  const files = args.years.flatMap((year) => args.symbols.map((symbol) => ({
    symbol, year, file: join(DATA_DIR, symbol, `${year}.csv`),
  })));
  const missing = files.filter((f) => !existsSync(f.file));
  if (missing.length > 0) {
    throw new ImportError(`Missing export files:\n  ${missing.map((f) => relative(REPO_ROOT, f.file)).join('\n  ')}`);
  }

  const touched: TimeRange[] = [];
  let done = 0;
  let loadSeconds = 0;
  let loaded = 0;
  for (const year of args.years) {
    let yearChanged = false;
    for (const symbol of args.symbols) {
      const file = join(DATA_DIR, symbol, `${year}.csv`);
      const result: ImportResult = await importPairRange(client, {
        symbol, pair: PAIRS[symbol], year, file,
        sourceFile: relative(REPO_ROOT, file).replace(/\\/g, '/'),
        range: yearRange(year),
        force: args.force.has(forceKey(symbol, year)),
        dryRun: args.dryRun,
      });
      done++;
      if (result.outcome === 'skipped') {
        log(`${symbol} ${year}: skipped (already imported, sha256 ${result.sha256.slice(0, 12)}…)`);
        continue;
      }
      loaded++;
      loadSeconds += result.seconds;
      const remaining = files.length - done;
      const eta = remaining > 0 ? `, ETA ${fmt((loadSeconds / loaded) * remaining)}` : '';
      log(`${symbol} ${year}: ${result.outcome}, ${result.importedRows.toLocaleString('en-US')} of ` +
        `${result.sourceRows.toLocaleString('en-US')} minutes kept, ${fmt(result.seconds)} ` +
        `(${Math.round(result.sourceRows / result.seconds).toLocaleString('en-US')} rows/s)` +
        `${result.decompressedChunks ? `, ${result.decompressedChunks} chunk(s) decompressed` : ''}${eta}`);
      if (result.outcome !== 'validated') {
        yearChanged = true;
        touched.push(yearRange(year));
      }
    }
    if (yearChanged) {
      const started = Date.now();
      const n = await compressChunks(client, 'historical_candles', yearRange(year).end);
      log(`${year}: compressed ${n} chunk(s) ending by ${year + 1}-01-01 in ${fmt((Date.now() - started) / 1000)}`);
    }
  }

  if (touched.length > 0) {
    const started = Date.now();
    const n = await compressChunks(client, 'historical_candles');
    log(`compressed the remaining ${n} chunk(s) in ${fmt((Date.now() - started) / 1000)}`);
  }
  return touched;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // the repo's .env on a laptop; a container passes the variables instead
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const client = new Client({
    host: env['DB_HOST'] || 'localhost',
    port: Number(env['DB_PORT']),
    user: env['DB_USER'],
    password: env['DB_PASS'],
    database: env['DB_NAME'],
    ssl: env['DB_SSL'] === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  try {
    await client.query('SET statement_timeout = 0');
    // Aggregate refreshes over millions of rows spill to temp files at the default
    // 4 MB (and every spill grows Docker's virtual disk); this session only.
    await client.query(`SET work_mem = '${CHECKS_WORK_MEM}'`);
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [ADVISORY_LOCK]);
    if (!lock.ok) throw new ImportError('Another historical import is running');

    const started = Date.now();
    log(`database ${env['DB_NAME']}; ${args.checkOnly ? 'checks only' :
      `${args.symbols.join(',')} ${args.years[0]}-${args.years[args.years.length - 1]}` +
      `${args.force.size ? `, force ${[...args.force].join(',')}` : ''}${args.dryRun ? ', DRY RUN' : ''}`}`);

    if (!args.checkOnly) {
      const touched = await importAll(client, args);
      if (touched.length > 0) {
        log('refreshing aggregates: 5m -> 15m -> 1h per year (UTC), then 4h -> 1d over the whole span +- 7 days');
        await refreshAggregates(client, touched, (s) => log(`  ${s.view} ${s.window.start.toISOString().slice(0, 10)}` +
          ` .. ${s.window.end.toISOString().slice(0, 10)}: ${fmt(s.seconds)}`));
        log(`vacuum (analyze) of M1 and the aggregates: ${fmt(await vacuumAnalyze(client))}`);
      } else {
        log(args.dryRun ? 'dry run: nothing written' : 'nothing to import');
      }
    }

    let failed = 0;
    if (args.check && !args.dryRun) {
      log('real-data checks');
      const results = await runChecks(client, (r, seconds) => {
        log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${fmt(seconds)})`);
        for (const line of r.lines) console.log(`          ${line}`);
      });
      failed = results.filter((r) => !r.ok).length;
    }
    log(`done in ${fmt((Date.now() - started) / 1000)}${failed ? `; ${failed} check(s) FAILED` : ''}`);
    if (failed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`\n${err.message}\n\n${USAGE}`);
  } else if (err instanceof ImportError) {
    console.error(`\n${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
