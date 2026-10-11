// The shared historical reader (@forexedge/database, used by the candles API and
// the backtester) against real imported excerpts in <DB_NAME>_test.
//   RUN_DB_TESTS=true npx nx test market-data-import --testFile=historical-reader.db.spec.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { getHistoricalCoverage, HistoricalDataError, readHistoricalBars, requireHistoricalCoverage } from '@forexedge/database';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { refreshAggregates } from './aggregates';
import { importPairRange } from './importer';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const FIXTURES = join(__dirname, 'fixtures');
const DAY = { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') };

// Decimal text -> points with string arithmetic
const points = (text: string, decimals: number) => {
  const [whole, fraction = ''] = text.split('.');
  return Number(whole + fraction.padEnd(decimals, '0'));
};

run('shared historical reader (real DB, real excerpts)', () => {
  jest.setTimeout(120_000);
  let testDb: TestDatabase;
  let client: Client;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    client = new Client(testDb.connection);
    await client.connect();
    for (const [symbol, pair] of [['EURUSD', 'EUR/USD'], ['XAUUSD', 'XAU/USD']]) {
      const file = `${symbol}-2022-01-03.csv`;
      await importPairRange(client, { symbol, pair, year: 2022, file: join(FIXTURES, file), sourceFile: file, range: DAY });
    }
    await refreshAggregates(client, [DAY]);
  });

  afterAll(async () => {
    await client?.end();
    await testDb?.drop();
  });

  it('reads coverage from historical_coverage', async () => {
    expect(await getHistoricalCoverage(testDb.dataSource, 'XAU/USD')).toEqual({
      pair: 'XAU/USD', priceDecimals: 3,
      firstTime: expect.any(Date), lastTime: expect.any(Date),
    });
    expect(await getHistoricalCoverage(testDb.dataSource, 'EUR/GBP')).toBeNull();
  });

  it('returns M1 bars in points exactly as in the source file, oldest first', async () => {
    const bars = await readHistoricalBars(testDb.dataSource, { pair: 'EUR/USD', timeframe: '1m', from: DAY.start, to: DAY.end });
    const traded = readFileSync(join(FIXTURES, 'EURUSD-2022-01-03.csv'), 'utf8').split('\n').slice(1).filter(Boolean)
      .map((l) => l.split(',')).filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0);
    expect(bars).toHaveLength(traded.length);
    expect(bars.length).toBeGreaterThan(0);
    bars.forEach((b, i) => {
      const c = traded[i];
      expect([b.bucket.getTime(), b.bidOpen, b.bidHigh, b.bidLow, b.bidClose, b.askOpen, b.askHigh, b.askLow, b.askClose])
        .toEqual([Number(c[0]), ...[1, 2, 3, 4, 6, 7, 8, 9].map((k) => points(c[k], 5))]);
    });
  });

  it('reads aggregates: H1 bars equal their M1 minutes', async () => {
    const h1 = await readHistoricalBars(testDb.dataSource, { pair: 'XAU/USD', timeframe: '1h', from: DAY.start, to: DAY.end });
    const m1 = await readHistoricalBars(testDb.dataSource, { pair: 'XAU/USD', timeframe: '1m', from: DAY.start, to: DAY.end });
    expect(h1.length).toBeGreaterThan(0);
    for (const bar of h1) {
      const inside = m1.filter((m) => m.bucket >= bar.bucket && m.bucket.getTime() < bar.bucket.getTime() + 3_600_000);
      expect(bar).toEqual({
        bucket: bar.bucket, minutes: inside.length,
        bidOpen: inside[0].bidOpen, askOpen: inside[0].askOpen,
        bidClose: inside[inside.length - 1].bidClose, askClose: inside[inside.length - 1].askClose,
        bidHigh: Math.max(...inside.map((m) => m.bidHigh)), askHigh: Math.max(...inside.map((m) => m.askHigh)),
        bidLow: Math.min(...inside.map((m) => m.bidLow)), askLow: Math.min(...inside.map((m) => m.askLow)),
      });
    }
  });

  it('returns the latest bars oldest first with a limit', async () => {
    const all = await readHistoricalBars(testDb.dataSource, { pair: 'EUR/USD', timeframe: '1h' });
    const last3 = await readHistoricalBars(testDb.dataSource, { pair: 'EUR/USD', timeframe: '1h', limit: 3 });
    expect(last3).toEqual(all.slice(-3));
  });

  it('rejects a pair without coverage and a window outside it', async () => {
    await expect(requireHistoricalCoverage(testDb.dataSource, 'EUR/GBP')).rejects.toMatchObject({ kind: 'no_coverage' });
    const outside = requireHistoricalCoverage(testDb.dataSource, 'EUR/USD', new Date('2023-01-01Z'));
    await expect(outside).rejects.toBeInstanceOf(HistoricalDataError);
    await expect(outside).rejects.toMatchObject({ kind: 'out_of_range' });
  });
});
