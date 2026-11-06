// Live ticks never touch the imported history. In <DB_NAME>_test (dropped, created and migrated per run),
// a real Dukascopy excerpt is imported, every historical_* relation is fingerprinted, real recorded ticks
// are written through the live feed's own write path (insertLiveTick, used by market-service's tick DB
// writer) and the live candles are refreshed; then the fingerprints must be identical and the ticks must
// be in `ticks`. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test market-data-import --testFile=live-isolation.db.spec.ts --skip-nx-cache
import { join } from 'node:path';
import { Client } from 'pg';
import { insertLiveTick, type LiveTickRow } from '@forexedge/database';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { importPairRange } from './importer';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const FIXTURES = join(__dirname, 'fixtures');

// Real ticks as market-service published them (Redis price:last:*, recorded 2026-10-10).
const RECORDED_TICKS: LiveTickRow[] = [
  { pair: 'EUR/USD', instrument: 'EUR_USD', bid: 1.08521, ask: 1.08533, mid: 1.08527, spread: 0.00012,
    timestamp: '2026-10-10T17:54:09.191Z', source: 'MOCK' },
  { pair: 'USD/JPY', instrument: 'USD_JPY', bid: 148.662, ask: 148.68, mid: 148.671, spread: 0.018,
    timestamp: '2026-10-10T17:54:09.191Z', source: 'MOCK' },
  { pair: 'GBP/USD', instrument: 'GBP_USD', bid: 1.26352, ask: 1.26368, mid: 1.2636, spread: 0.00016,
    timestamp: '2026-10-10T17:54:09.191Z', source: 'MOCK' },
  { pair: 'XAU/USD', instrument: 'XAU_USD', bid: 1841.56, ask: 1842.002, mid: 1841.781, spread: 0.442,
    timestamp: '2026-10-10T17:54:09.191Z', source: 'MOCK' },
];

interface Fingerprint { relation: string; rows: number; md5: string | null }

run('live ticks vs the imported history (real DB)', () => {
  jest.setTimeout(180_000);
  let testDb: TestDatabase;
  let client: Client;

  // Every historical_* table, view and continuous aggregate: row count and a content hash.
  const fingerprint = async (): Promise<Fingerprint[]> => {
    const { rows: relations } = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname LIKE 'historical\\_%' AND c.relkind IN ('r', 'v', 'm', 'p')
        ORDER BY c.relname`);
    const out: Fingerprint[] = [];
    for (const { relname } of relations as { relname: string }[]) {
      const { rows: [r] } = await client.query(
        `SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS md5 FROM "${relname}" t`);
      out.push({ relation: relname, rows: r.rows, md5: r.md5 });
    }
    return out;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    client = new Client(testDb.connection);
    await client.connect();
    const result = await importPairRange(client, {
      symbol: 'EURUSD', pair: 'EUR/USD', year: 2022,
      range: { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') },
      file: join(FIXTURES, 'EURUSD-2022-01-03.csv'),
      sourceFile: 'tools/market-data/import/src/fixtures/EURUSD-2022-01-03.csv',
    });
    expect(result.importedRows).toBe(1425);
  });

  afterAll(async () => {
    await client?.end();
    await testDb?.drop();
  });

  it('runs in a _test database', async () => {
    expect((await client.query('SELECT current_database() AS db')).rows[0].db).toMatch(/_test$/);
  });

  it('writes live ticks only to ticks; every historical_* relation is unchanged', async () => {
    const before = await fingerprint();
    const names = before.map((f) => f.relation);
    expect(names).toEqual(expect.arrayContaining(['historical_candles', 'historical_coverage', 'historical_import_log']));
    expect(before.find((f) => f.relation === 'historical_candles')?.rows).toBe(1425);
    expect(before.reduce((n, f) => n + f.rows, 0)).toBeGreaterThan(1425);
    const ticksBefore = Number((await client.query('SELECT count(*) AS n FROM ticks')).rows[0].n);

    for (const tick of RECORDED_TICKS) await insertLiveTick(client, tick);
    // Materialize the live candles over the ticks' minute as the continuous-aggregate policy would
    await client.query(
      `CALL refresh_continuous_aggregate('candles_1m', '2026-10-10T17:00:00Z'::timestamptz, '2026-10-10T19:00:00Z'::timestamptz)`);

    expect(await fingerprint()).toEqual(before);
    const { rows } = await client.query(
      `SELECT instrument, bid::float8 AS bid, ask::float8 AS ask, source FROM ticks
        WHERE time = '2026-10-10T17:54:09.191Z' ORDER BY instrument`);
    expect(rows).toEqual(RECORDED_TICKS.map((t) => ({ instrument: t.instrument, bid: t.bid, ask: t.ask, source: t.source }))
      .sort((a, b) => a.instrument.localeCompare(b.instrument)));
    expect(Number((await client.query('SELECT count(*) AS n FROM ticks')).rows[0].n)).toBe(ticksBefore + RECORDED_TICKS.length);
    const candles = await client.query(`SELECT count(*)::int AS n FROM candles_1m WHERE bucket = '2026-10-10T17:54:00Z'`);
    expect(candles.rows[0].n).toBe(RECORDED_TICKS.length);
  });
});
