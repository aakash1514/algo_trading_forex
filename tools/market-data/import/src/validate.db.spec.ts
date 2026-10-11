// The FRED comparison on real data: a verbatim DEXUSEU excerpt (fixtures/
// DEXUSEU-2021-12-31-to-2022-01-04.csv, copied from tools/market-data/reference/
// DEXUSEU.csv) against the real EUR/USD 2022-01-03 M1 excerpt, in <DB_NAME>_test.
//   RUN_DB_TESTS=true npx nx test market-data-import --testFile=validate.db.spec.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { importPairRange } from './importer';
import { compareSeries, FX_SERIES, parseFredCsv } from './validate';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const FIXTURES = join(__dirname, 'fixtures');

run('FRED noon fixing vs our noon mid (real DB, real excerpts)', () => {
  jest.setTimeout(120_000);
  let testDb: TestDatabase;
  let client: Client;
  const eurusd = FX_SERIES[0];
  const fixings = parseFredCsv(readFileSync(join(FIXTURES, 'DEXUSEU-2021-12-31-to-2022-01-04.csv'), 'utf8'), 'DEXUSEU');

  beforeAll(async () => {
    expect(eurusd.id).toBe('DEXUSEU');
    testDb = await createTestDatabase();
    client = new Client(testDb.connection);
    await client.connect();
    await importPairRange(client, {
      symbol: 'EURUSD', pair: 'EUR/USD', year: 2022, file: join(FIXTURES, 'EURUSD-2022-01-03.csv'),
      sourceFile: 'tools/market-data/import/src/fixtures/EURUSD-2022-01-03.csv',
      range: { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') },
    });
  });

  afterAll(async () => {
    await client?.end();
    await testDb?.drop();
  });

  it('skips FRED holidays (empty value) and keeps the published text', () => {
    expect(fixings).toEqual([{ date: '2022-01-03', value: '1.1290' }, { date: '2022-01-04', value: '1.1296' }]);
  });

  it('compares the 11:59 New York bar exactly: mid 1.128895 vs fixing 1.1290 is -1.05 pips', async () => {
    const [result] = await compareSeries(client, eurusd, fixings);
    // 2022-01-03 11:59 NY = 16:59 UTC: bid close 1.12888, ask close 1.12891 (fixture row 1641229140000)
    expect(result).toMatchObject({
      pair: 'EUR/USD', year: 2022, fixings: 2, compared: 1, noData: 1, // 2022-01-04 has no M1 in this database
      medianPips: 1.05, meanSignedPips: -1.05, maxPips: 1.05, maxDate: '2022-01-03', failing: [],
    });
    // One hour off either way fits worse (EUR/USD drifted that day)
    expect(result.medianByOffset[0]).toBeLessThan(result.medianByOffset[-60] as number);
    expect(result.medianByOffset[0]).toBeLessThan(result.medianByOffset[60] as number);
    expect(result.ok).toBe(true);
  });

  it('fails on empty input', async () => {
    const results = await compareSeries(client, eurusd, []);
    expect(results.every((r) => !r.ok)).toBe(true);
    const header = parseFredCsv('observation_date,DEXUSEU\n2021-12-31,\n', 'DEXUSEU');
    expect(header).toEqual([]);
  });
});
