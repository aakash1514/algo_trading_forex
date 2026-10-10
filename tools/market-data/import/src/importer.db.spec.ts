// Importer against a real database, with real Dukascopy excerpts only
// (src/fixtures, see its README). Runs in <DB_NAME>_test (dropped, created and
// migrated per run), never the development database. Skipped unless
// RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test market-data-import --testFile=importer.db.spec.ts
//
// The steps share one database and run in order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { refreshAggregates } from './aggregates';
import { runChecks } from './checks';
import { compressChunks, ImportError, importPairRange, type ImportRequest } from './importer';
import type { TimeRange } from './pairs';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const FIXTURES = join(__dirname, 'fixtures');
const d = (iso: string) => new Date(iso);

const DAY_2022: TimeRange = { start: d('2022-01-03T00:00Z'), end: d('2022-01-04T00:00Z') };
const PM_2012: TimeRange = { start: d('2012-12-31T12:00Z'), end: d('2013-01-01T00:00Z') };
const TO_NOON_2013: TimeRange = { start: d('2013-01-01T00:00Z'), end: d('2013-01-02T12:00Z') };

function request(fixture: string, pair: string, year: number, range: TimeRange, extra: Partial<ImportRequest> = {}):
  ImportRequest {
  return {
    symbol: pair.replace('/', ''), pair, year, range,
    file: join(FIXTURES, fixture), sourceFile: `tools/market-data/import/src/fixtures/${fixture}`, ...extra,
  };
}

// Decimal text -> integer points with string arithmetic (no JS float involved)
function points(text: string, decimals: number): string {
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`${text} has more than ${decimals} decimals`);
  return BigInt(whole + fraction.padEnd(decimals, '0')).toString();
}

// The fixture's traded minutes, converted the way the importer must store them
function expectedRows(fixture: string, priceDecimals: number): string[][] {
  return readFileSync(join(FIXTURES, fixture), 'utf8').split('\n').slice(1).filter(Boolean)
    .map((line) => line.split(','))
    .filter((c) => points(c[5], 6) !== '0' || points(c[10], 6) !== '0')
    .map((c) => [c[0], ...[1, 2, 3, 4, 6, 7, 8, 9].map((i) => points(c[i], priceDecimals)), points(c[5], 6), points(c[10], 6)]);
}

run('historical importer (real DB, real Dukascopy excerpts)', () => {
  jest.setTimeout(180_000);
  let testDb: TestDatabase;
  let client: Client;

  const storedRows = async (pair: string, range: TimeRange): Promise<string[][]> => {
    const { rows } = await client.query({
      text: `SELECT (extract(epoch FROM time) * 1000)::bigint::text, bid_open::text, bid_high::text, bid_low::text,
                    bid_close::text, ask_open::text, ask_high::text, ask_low::text, ask_close::text,
                    bid_volume::text, ask_volume::text
             FROM historical_candles WHERE pair = $1 AND time >= $2 AND time < $3 ORDER BY time`,
      values: [pair, range.start, range.end],
      rowMode: 'array',
    });
    return rows;
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await client.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    testDb = await createTestDatabase();
    client = new Client(testDb.connection);
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await testDb?.drop();
  });

  it('runs in a _test database', async () => {
    expect((await client.query('SELECT current_database() AS db')).rows[0].db).toMatch(/_test$/);
  });

  it('imports EUR/USD at 5 decimals: traded minutes only, every value exact', async () => {
    const result = await importPairRange(client, request('EURUSD-2022-01-03.csv', 'EUR/USD', 2022, DAY_2022));
    const expected = expectedRows('EURUSD-2022-01-03.csv', 5);
    expect(result).toMatchObject({ outcome: 'imported', sourceRows: 1440, importedRows: expected.length });
    expect(expected.length).toBe(1425); // 15 minutes of the day had no volume on either side
    expect(await storedRows('EUR/USD', DAY_2022)).toEqual(expected);

    const { rows: [logRow] } = await client.query('SELECT * FROM historical_import_log WHERE pair = $1', ['EUR/USD']);
    expect(logRow).toMatchObject({
      year: 2022, source_rows: 1440, imported_rows: 1425, price_decimals: 5, volume_decimals: 6,
      source_file: 'tools/market-data/import/src/fixtures/EURUSD-2022-01-03.csv',
    });
    expect(logRow.source_sha256).toBe(result.sha256);
  });

  it('imports XAU/USD at 3 decimals', async () => {
    const result = await importPairRange(client, request('XAUUSD-2022-01-03.csv', 'XAU/USD', 2022, DAY_2022));
    const expected = expectedRows('XAUUSD-2022-01-03.csv', 3);
    expect(result.importedRows).toBe(expected.length);
    expect(await storedRows('XAU/USD', DAY_2022)).toEqual(expected);
  });

  it('skips a pair-year already imported from the same file', async () => {
    const before = await count('SELECT count(*) AS n FROM historical_candles');
    const result = await importPairRange(client, request('EURUSD-2022-01-03.csv', 'EUR/USD', 2022, DAY_2022));
    expect(result.outcome).toBe('skipped');
    expect(await count('SELECT count(*) AS n FROM historical_candles')).toBe(before);
  });

  it('stops when the file differs from the one imported, unless forced', async () => {
    // A different real file for the same pair-year has a different hash
    await expect(importPairRange(client, request('XAUUSD-2022-01-03.csv', 'EUR/USD', 2022, DAY_2022)))
      .rejects.toThrow(/changed since it was imported.*--force EURUSD:2022/);
    expect(await storedRows('EUR/USD', DAY_2022)).toEqual(expectedRows('EURUSD-2022-01-03.csv', 5));
  });

  it.each([
    ['the first row is not the period start', { start: d('2022-01-03T00:01Z'), end: d('2022-01-04T00:01Z') },
      'first row is 2022-01-03T00:00:00.000Z, expected 2022-01-03T00:01:00.000Z'],
    ['the file is shorter than the period', { start: d('2022-01-03T00:00Z'), end: d('2022-01-04T00:01Z') },
      '1440 rows, expected 1441'],
    ['the file is longer than the period', { start: d('2022-01-03T00:00Z'), end: d('2022-01-03T23:59Z') },
      '1440 rows, expected 1439'],
  ])('rejects a file when %s, writing nothing', async (_why, range, message) => {
    const before = await count('SELECT count(*) AS n FROM historical_candles');
    await expect(importPairRange(client, request('EURUSD-2022-01-03.csv', 'EUR/USD', 2021, range)))
      .rejects.toThrow(message);
    expect(await count('SELECT count(*) AS n FROM historical_import_log WHERE year = 2021')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM historical_candles')).toBe(before);
  });

  it('refuses to round: real 5-decimal prices against a 4-decimal scale are rejected', async () => {
    // No GBP/USD pair-year is imported yet, so its scale can still be changed (test database only)
    await client.query(`UPDATE historical_price_scale SET price_decimals = 4 WHERE pair = 'GBP/USD'`);
    try {
      const error = await importPairRange(client, request('EURUSD-2022-01-03.csv', 'GBP/USD', 2022, DAY_2022))
        .catch((e) => e);
      expect(error).toBeInstanceOf(ImportError);
      expect(error.message).toMatch(/rows have a price that is not a whole number at 4 decimals .*refusing to round/);
      expect(await count(`SELECT count(*) AS n FROM historical_candles WHERE pair = 'GBP/USD'`)).toBe(0);
    } finally {
      await client.query(`UPDATE historical_price_scale SET price_decimals = 5 WHERE pair = 'GBP/USD'`);
    }
  });

  it('keeps the scale fixed once a pair-year is imported', async () => {
    await expect(client.query(`UPDATE historical_price_scale SET price_decimals = 4 WHERE pair = 'EUR/USD'`))
      .rejects.toThrow(/historical_import_log_scale_fkey/);
  });

  it('--force on compressed chunks decompresses only the overlapping chunks and restores identical rows', async () => {
    expect(await compressChunks(client, 'historical_candles')).toBeGreaterThan(0);
    const compressed = async () => (await client.query(
      `SELECT chunk_name, range_start, range_end, is_compressed FROM timescaledb_information.chunks
       WHERE hypertable_name = 'historical_candles' ORDER BY range_start`)).rows;
    const chunksBefore = await compressed();
    expect(chunksBefore.every((c) => c.is_compressed)).toBe(true);
    const fingerprint = () => client.query(
      `SELECT md5(string_agg(c::text, '|' ORDER BY pair, time)) AS h FROM historical_candles c`).then((r) => r.rows[0].h);
    const before = await fingerprint();
    const { rows: [{ imported_at: importedBefore }] } = await client.query(
      `SELECT imported_at FROM historical_import_log WHERE pair = 'EUR/USD' AND year = 2022`);

    const result = await importPairRange(client, request('EURUSD-2022-01-03.csv', 'EUR/USD', 2022, DAY_2022, { force: true }));
    expect(result).toMatchObject({ outcome: 'replaced', importedRows: 1425 });
    const overlapping = chunksBefore.filter((c) => c.range_start < DAY_2022.end && c.range_end > DAY_2022.start);
    expect(result.decompressedChunks).toBe(overlapping.length);

    const chunksAfter = await compressed();
    for (const chunk of chunksAfter) {
      const wasOverlapping = overlapping.some((o) => o.chunk_name === chunk.chunk_name);
      expect(chunk.is_compressed).toBe(!wasOverlapping); // only the overlapping chunk was touched
    }
    expect(await fingerprint()).toBe(before);
    const { rows: [{ imported_at: importedAfter }] } = await client.query(
      `SELECT imported_at FROM historical_import_log WHERE pair = 'EUR/USD' AND year = 2022`);
    expect(importedAfter.getTime()).toBeGreaterThan(importedBefore.getTime());

    expect(await compressChunks(client, 'historical_candles')).toBe(overlapping.length);
  });

  it('materializes the New York bar that crosses the year boundary (yearly windows miss it)', async () => {
    await importPairRange(client, request('EURUSD-2012-12-31-pm.csv', 'EUR/USD', 2012, PM_2012));
    await importPairRange(client, request('EURUSD-2013-01-01-to-02-noon.csv', 'EUR/USD', 2013, TO_NOON_2013));
    // EUR/USD traded 16 minutes between 22:00 and 24:00 UTC on 2012-12-31 (17:00-19:00 New York)
    expect(await count(`SELECT count(*) AS n FROM historical_candles
                        WHERE pair = 'EUR/USD' AND time >= '2012-12-31T22:00Z' AND time < '2013-01-01T00:00Z'`)).toBe(16);
    const bar = (view: string) => client.query(
      `SELECT minutes FROM ${view} WHERE pair = 'EUR/USD' AND bucket = '2012-12-31T22:00Z'`).then((r) => r.rows);

    // The bug: yearly windows never contain the bar 2012-12-31 22:00 -> 2013-01-01 22:00 UTC
    for (const [from, to] of [['2012-01-01', '2013-01-01'], ['2013-01-01', '2014-01-01']]) {
      await client.query(`CALL refresh_continuous_aggregate('historical_candles_4h', '${from}', '${to}')`);
      await client.query(`CALL refresh_continuous_aggregate('historical_candles_1d', '${from}', '${to}')`);
    }
    expect(await bar('historical_candles_1d')).toEqual([]);

    // The importer's refresh: one padded window for the New York aggregates
    await refreshAggregates(client, [DAY_2022, PM_2012, TO_NOON_2013]);
    expect(await bar('historical_candles_4h')).toEqual([{ minutes: 16 }]);
    expect(await bar('historical_candles_1d')).toEqual([{ minutes: 16 }]);
  });

  it('passes every real-data check', async () => {
    const results = await runChecks(client);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    const boundaries = results.find((r) => r.name.startsWith('No missing'));
    // stored/rebuilt bar counts around 2013-01-01 are equal and nothing is missing
    expect(boundaries?.lines.find((l) => l.startsWith('2012/2013:'))).toMatch(/^2012\/2013: 4h (\d+)\/\1, 1d (\d+)\/\2$/);
  });

  it('refuses to revert the integer layout while historical rows exist', async () => {
    await expect(testDb.dataSource.undoLastMigration({ transaction: 'each' }))
      .rejects.toThrow(/Refusing to restore the float8 historical layout/);
  });
});
