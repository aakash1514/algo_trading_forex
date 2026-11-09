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

  // Walks the migrations down from the newest; a new migration must be added here
  it('reverts ReplayTables, CalendarThirdPartyEvents (refusing while third-party rows exist), CalendarEventTimes, RemovePreOfficialCalendarEvents, EconomicEventSource, ResearchReadRole and ReadOnlyRole, refuses BacktestRunMoney while runs exist, then the integer layout while history exists', async () => {
    const last = async () => (await client.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1')).rows[0]?.name;
    expect(await last()).toBe('ReplayTables1792500000000');

    // ReplayTables: down() drops both replay tables; the cluster-wide role is kept (as ReadOnlyRole)
    const replayTables = async () => (await client.query(
      `SELECT array_remove(ARRAY[to_regclass('replay_positions')::text, to_regclass('replay_sessions')::text], NULL) AS t`,
    )).rows[0].t;
    expect(await replayTables()).toEqual(['replay_positions', 'replay_sessions']);
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await replayTables()).toEqual([]);
    expect((await client.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'forexedge_replay_writer'`)).rows[0].n).toBe(1);
    expect(await last()).toBe('CalendarThirdPartyEvents1792400000000');

    // CalendarThirdPartyEvents: 'third_party' allowed and the resync key includes the currency; down() refuses
    // while a third-party row exists (the row is a real Forex Factory event, 2026-11-06 export)
    const ffRow = `INSERT INTO economic_events (title, currency, impact, scheduled_at, source, time_source)
       VALUES ('Unemployment Rate', $1, 'HIGH', '2026-11-06T13:30:00Z', 'FOREXFACTORY', 'third_party')`;
    await client.query(ffRow, ['CAD']);
    await client.query(ffRow, ['USD']);
    await expect(testDb.dataSource.undoLastMigration({ transaction: 'each' })).rejects.toThrow(/2 third-party row\(s\) exist/);
    await client.query(`DELETE FROM economic_events WHERE time_source = 'third_party'`);
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await last()).toBe('CalendarEventTimes1792300000000');

    // CalendarEventTimes: time_source (official/expected) replaces all_day; down() restores all_day
    const timeColumns = async () => (await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'economic_events' AND column_name IN ('time_source', 'all_day') ORDER BY column_name`,
    )).rows.map((r: { column_name: string }) => r.column_name);
    expect(await timeColumns()).toEqual(['time_source']);
    await expect(client.query(
      `INSERT INTO economic_events (title, currency, impact, scheduled_at, source, time_source)
       VALUES ('x', 'USD', 'HIGH', now(), 'FOMC', 'guessed')`,
    )).rejects.toThrow(/economic_events_time_source/);
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await timeColumns()).toEqual(['all_day']);
    expect(await last()).toBe('RemovePreOfficialCalendarEvents1792200000000');

    // RemovePreOfficialCalendarEvents: source is required; down() makes it optional again
    const sourceNullable = async () => (await client.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'economic_events' AND column_name = 'source'`,
    )).rows[0]?.is_nullable;
    expect(await sourceNullable()).toBe('NO');
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await sourceNullable()).toBe('YES');
    expect(await last()).toBe('EconomicEventSource1792100000000');

    // EconomicEventSource: economic_events.source and all_day, and the per-source unique index
    const eventColumns = async () => (await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'economic_events' AND column_name IN ('source', 'all_day') ORDER BY column_name`,
    )).rows.map((r: { column_name: string }) => r.column_name);
    expect(await eventColumns()).toEqual(['all_day', 'source']);
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await eventColumns()).toEqual([]);
    expect(await last()).toBe('ResearchReadRole1792000000000');

    // ResearchReadRole: column-level SELECT on backtest_runs only (never minio_object_key
    // or error_message); down() revokes this database's grants and keeps the cluster-wide role
    const researchColumns = async () => (await client.query(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE grantee = 'forexedge_research_reader' AND table_name = 'backtest_runs' AND privilege_type = 'SELECT'
       ORDER BY column_name`)).rows.map((r: { column_name: string }) => r.column_name);
    const granted = await researchColumns();
    expect(granted).toHaveLength(21);
    expect(granted).not.toContain('minio_object_key');
    expect(granted).not.toContain('error_message');
    expect((await client.query(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'forexedge_research_reader'`,
    )).rows[0].n).toBe(0); // no table-level grant on anything
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await researchColumns()).toEqual([]);
    expect((await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'forexedge_research_reader'`)).rowCount).toBe(1);
    expect(await last()).toBe('ReadOnlyRole1791900000000');

    // ReadOnlyRole ran although the role already existed on the cluster (idempotent);
    // its down() revokes this database's grants and keeps the cluster-wide role
    const grants = async () => (await client.query(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE grantee = 'forexedge_readonly' AND table_name = 'historical_candles_1h'`)).rows[0].n;
    expect(await grants()).toBe(1);
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await grants()).toBe(0);
    expect((await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'forexedge_readonly'`)).rowCount).toBe(1);
    expect(await last()).toBe('BacktestRunMoney1791800000000');

    // A run in backtest_runs blocks BacktestRunMoney.down()
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, username, password_hash) VALUES ('migration-guard@example.com', 'migration_guard', 'x') RETURNING id`);
    await client.query(
      `INSERT INTO backtest_runs (user_id, strategy_name, instrument, timeframe, from_date, to_date, initial_capital, lots)
       VALUES ($1, 'ma_crossover', 'EUR_USD', '1h', '2022-01-03', '2022-01-03', 10000, 0.1)`, [user.id]);
    await expect(testDb.dataSource.undoLastMigration({ transaction: 'each' })).rejects.toThrow('backtest_runs has 1 run(s)');
    expect(await last()).toBe('BacktestRunMoney1791800000000');

    // Without runs it reverts, and the integer layout is next: it refuses while history exists
    await client.query('DELETE FROM backtest_runs');
    await testDb.dataSource.undoLastMigration({ transaction: 'each' });
    expect(await last()).toBe('HistoricalCandlesIntegerPoints1791720000000');
    await expect(testDb.dataSource.undoLastMigration({ transaction: 'each' }))
      .rejects.toThrow(/Refusing to restore the float8 historical layout/);
    expect(await last()).toBe('HistoricalCandlesIntegerPoints1791720000000');
  });
});
