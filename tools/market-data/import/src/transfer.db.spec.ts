// The history transfer on real Dukascopy minutes (the importer's fixtures) in <DB_NAME>_test:
// export -> check -> wipe -> import, and every way an import must refuse or a check must fail.
//   RUN_DB_TESTS=true npx nx test market-data-import --testFile=transfer.db.spec.ts --skip-nx-cache
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { importPairRange } from './importer';
import type { TimeRange } from './pairs';
import { compareWithManifest, exportHistory, importHistory, MANIFEST, readManifest } from './transfer';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const FIXTURES = join(__dirname, 'fixtures');
const DAY_2022: TimeRange = { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') };

describe('readManifest', () => {
  it('refuses a directory without a manifest, and a manifest that lists nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-'));
    try {
      expect(() => readManifest(dir)).toThrow('manifest.json is missing');
      writeFileSync(join(dir, MANIFEST), JSON.stringify({ format: 1, candles: [], files: [] }));
      expect(() => readManifest(dir)).toThrow('lists no history');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

run('history transfer (real DB, real minutes)', () => {
  jest.setTimeout(300_000);
  let testDb: TestDatabase;
  let client: Client;
  let exportDir: string;
  const count = async (sql: string) => Number((await client.query(sql)).rows[0].n);
  const wipe = () => client.query('TRUNCATE historical_candles, historical_import_log');

  beforeAll(async () => {
    testDb = await createTestDatabase();
    client = new Client(testDb.connection);
    await client.connect();
    for (const [fixture, pair] of [['EURUSD-2022-01-03.csv', 'EUR/USD'], ['XAUUSD-2022-01-03.csv', 'XAU/USD']]) {
      await importPairRange(client, {
        symbol: pair.replace('/', ''), pair, year: 2022, range: DAY_2022,
        file: join(FIXTURES, fixture), sourceFile: `tools/market-data/import/src/fixtures/${fixture}`,
      });
    }
    exportDir = mkdtempSync(join(tmpdir(), 'transfer-'));
  });

  afterAll(async () => {
    await client?.end();
    await testDb?.drop();
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('exports every pair and the import log; the source matches its own manifest', async () => {
    const manifest = await exportHistory(client, exportDir);
    expect(manifest.candles.map((p) => p.pair)).toEqual(['EUR/USD', 'XAU/USD']);
    const minutes = manifest.candles.reduce((n, p) => n + Number(p.rows), 0);
    expect(minutes).toBe(await count('SELECT count(*)::int AS n FROM historical_candles'));
    expect(minutes).toBeGreaterThan(2_000);
    expect(manifest.importLogRows).toBe(2);
    expect(manifest.files).toHaveLength(3);
    expect(await compareWithManifest(client, manifest)).toEqual([]);
    await expect(exportHistory(client, exportDir)).rejects.toThrow('already holds an export');
  });

  it('check fails on an empty database and on a partial one', async () => {
    const manifest = readManifest(exportDir);
    await client.query(`DELETE FROM historical_candles WHERE pair = 'XAU/USD'`);
    expect(await compareWithManifest(client, manifest)).toEqual(expect.arrayContaining([expect.stringMatching(/^XAU\/USD: missing/)]));
    await wipe();
    const problems = await compareWithManifest(client, manifest);
    expect(problems).toEqual(expect.arrayContaining(['historical_candles is empty', expect.stringMatching(/^EUR\/USD: missing/)]));
  });

  it('import refuses a partial or altered export before writing anything', async () => {
    const xau = join(exportDir, 'historical_candles_XAUUSD.csv.gz');
    const saved = join(exportDir, 'xau.bak');
    copyFileSync(xau, saved);
    unlinkSync(xau);
    await expect(importHistory(client, exportDir)).rejects.toThrow('historical_candles_XAUUSD.csv.gz is missing');
    copyFileSync(saved, xau);
    appendFileSync(xau, Buffer.from([0]));
    await expect(importHistory(client, exportDir)).rejects.toThrow('sha256 differs');
    copyFileSync(saved, xau);
    unlinkSync(saved);
    expect(await count('SELECT count(*)::int AS n FROM historical_candles')).toBe(0);
  });

  it('imports into the empty database: identical rows, aggregates rebuilt from them', async () => {
    const summary = await importHistory(client, exportDir);
    expect(summary.problems).toEqual([]);
    expect(summary.refreshSteps).toBeGreaterThan(0);
    // every aggregate counts exactly the minutes of M1
    for (const view of ['historical_candles_5m', 'historical_candles_1h', 'historical_candles_1d']) {
      expect(await count(`SELECT sum(minutes)::int AS n FROM ${view}`)).toBe(summary.rows - 2);
    }
    await expect(importHistory(client, exportDir)).rejects.toThrow('already holds history');
  });

  it('check notices one changed price among thousands (same row count)', async () => {
    const manifest = readManifest(exportDir);
    const minute = `pair = 'EUR/USD' AND time = '2022-01-03T09:40:00Z'`;
    await client.query(`SELECT decompress_chunk(c, true) FROM show_chunks('historical_candles') c`);
    await client.query(`UPDATE historical_candles SET bid_close = bid_close + 1 WHERE ${minute}`);
    expect(await compareWithManifest(client, manifest)).toEqual(['EUR/USD: sum(bid_close) differs']);
    await client.query(`UPDATE historical_candles SET bid_close = bid_close - 1 WHERE ${minute}`);
    expect(await compareWithManifest(client, manifest)).toEqual([]);
  });
});
