import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { EconomicEventEntity } from '@forexedge/database';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { OfficialCalendarService, describeFailure, fetchPage, type PageFetcher } from './official-calendar.service';
import { EconomicCalendarService } from './economic-calendar.service';
import { CALENDAR_USER_AGENT, OFFICIAL_SOURCES } from './official-sources';
import { parseEcbCalendar } from './ecb.parser';
import { parseFomcCalendar } from './fomc.parser';

// The recorded official pages (__fixtures__/README.md) stand in for the network: the default suite
// never fetches anything.
const FIXTURES = join(__dirname, '__fixtures__');
const PAGES: Record<string, string> = {
  [OFFICIAL_SOURCES.FOMC.url]: readFileSync(join(FIXTURES, 'fomccalendars.htm'), 'utf8'),
  [OFFICIAL_SOURCES.ECB.url]: readFileSync(join(FIXTURES, 'ecb-mgcgc-index.en.html'), 'utf8'),
};
const NOW = new Date('2026-10-12T09:00:00Z');

const recordedFetcher = () =>
  jest.fn<ReturnType<PageFetcher>, Parameters<PageFetcher>>(async (url) => ({ status: 200, body: PAGES[url] }));

// Redis SET ... NX EX: the first claim of a key wins
function fakeRedis() {
  const keys = new Map<string, string>();
  return {
    keys,
    set: jest.fn(async (key: string, value: string) => {
      if (keys.has(key)) return null;
      keys.set(key, value);
      return 'OK';
    }),
  };
}

describe('the default suite is offline', () => {
  it('fails any real request (jest.setup.cjs), including the service’s own fetcher', async () => {
    await expect(fetchPage(OFFICIAL_SOURCES.FOMC.url, CALENDAR_USER_AGENT)).rejects.toThrow(/Network access is disabled/);
  });
});

describe('OfficialCalendarService (recorded pages, no network)', () => {
  function setup() {
    const queries: [string, unknown[]][] = [];
    const dataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<void>) =>
        cb({ query: jest.fn(async (sql: string, params: unknown[]) => queries.push([sql.replace(/\s+/g, ' ').trim(), params])) })),
    };
    const redis = fakeRedis();
    const service = new OfficialCalendarService(dataSource as unknown as DataSource, redis as unknown as Redis);
    service.fetcher = recordedFetcher();
    return { service, queries, redis, dataSource };
  }

  it('fetches each source once with the ForexEdge User-Agent and stores every parsed event as all-day', async () => {
    const { service, queries } = setup();
    const outcomes = await service.syncAll(NOW);
    const fomc = parseFomcCalendar(PAGES[OFFICIAL_SOURCES.FOMC.url]).length;
    const ecb = parseEcbCalendar(PAGES[OFFICIAL_SOURCES.ECB.url]).length;
    expect(fomc).toBeGreaterThan(0);
    expect(ecb).toBeGreaterThan(0);
    expect(outcomes).toEqual([
      { source: 'FOMC', outcome: 'synced', events: fomc },
      { source: 'ECB', outcome: 'synced', events: ecb },
    ]);
    expect(service.fetcher).toHaveBeenCalledTimes(2);
    for (const call of (service.fetcher as jest.Mock).mock.calls) expect(call[1]).toBe(CALENDAR_USER_AGENT);
    expect(CALENDAR_USER_AGENT).toMatch(/^ForexEdge\//);

    const deletes = queries.filter(([sql]) => sql.startsWith('DELETE'));
    expect(deletes.map(([, p]) => p)).toEqual([['FOMC', '2026-10-12T00:00:00Z'], ['ECB', '2026-10-12T00:00:00Z']]);
    const inserts = queries.filter(([sql]) => sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(fomc + ecb);
    expect(inserts[0][0]).toContain('VALUES ($1, $2, $3, $4, true, $5)');
    expect(inserts.find(([, p]) => p[0] === 'FOMC meeting, October 27-28')?.[1])
      .toEqual(['FOMC meeting, October 27-28', 'USD', 'HIGH', '2026-10-28T00:00:00Z', 'FOMC']);
  });

  it('fetches at most once per UTC day per source, even across restarts, and again the next day', async () => {
    const { service, redis } = setup();
    await service.syncAll(NOW);
    const again = await service.syncAll(new Date('2026-10-12T23:59:00Z'));
    expect(again).toEqual([{ source: 'FOMC', outcome: 'skipped' }, { source: 'ECB', outcome: 'skipped' }]);
    expect(service.fetcher).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith('calendar:fetched:FOMC:2026-10-12', NOW.toISOString(), 'EX', 172_800, 'NX');

    const nextDay = await service.syncAll(new Date('2026-10-13T06:15:00Z')); // the daily cron
    expect(nextDay.map((o) => o.outcome)).toEqual(['synced', 'synced']);
    expect(service.fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps the last good events (writes nothing) on an HTTP error or a page it cannot parse', async () => {
    const { service, dataSource } = setup();
    service.fetcher = jest.fn(async (url: string) =>
      url === OFFICIAL_SOURCES.FOMC.url ? { status: 403, body: 'Access Denied' }
        : { status: 200, body: PAGES[url].replace(/<dl>/, '<dl class="changed">') });
    const outcomes = await service.syncAll(NOW);
    expect(outcomes).toEqual([
      { source: 'FOMC', outcome: 'kept', reason: 'HTTP 403' },
      { source: 'ECB', outcome: 'kept', reason: 'ECB: meeting schedule list not found' },
    ]);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('names the underlying network error code that Node fetch hides behind "fetch failed"', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(describeFailure(err)).toBe('fetch failed: ECONNRESET');
    expect(describeFailure(new Error('HTTP 403'))).toBe('HTTP 403');
  });
});

const runDb = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

runDb('OfficialCalendarService against the real schema (RUN_DB_TESTS)', () => {
  jest.setTimeout(180_000);
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb?.drop();
  });

  it('stores the recorded calendars, resyncs idempotently, keeps them on a failure, and lists today’s all-day events', async () => {
    const ds = testDb.dataSource;
    const count = async () => Number((await ds.query(`SELECT count(*) AS n FROM economic_events WHERE source IS NOT NULL`))[0].n);
    const sync = async (fetcher: PageFetcher) => {
      const service = new OfficialCalendarService(ds, fakeRedis() as unknown as Redis);
      service.fetcher = fetcher;
      return service.syncAll(NOW);
    };

    await sync(recordedFetcher());
    const stored = await count();
    const parsed = parseFomcCalendar(PAGES[OFFICIAL_SOURCES.FOMC.url]).length + parseEcbCalendar(PAGES[OFFICIAL_SOURCES.ECB.url]).length;
    expect(stored).toBeGreaterThan(0);
    // Same-day duplicates (e.g. the ECB lists Day 2 and its press conference separately) have different titles
    expect(stored).toBe(parsed);

    await sync(recordedFetcher());
    expect(await count()).toBe(stored);

    await sync(jest.fn(async () => ({ status: 503, body: '' })));
    expect(await count()).toBe(stored);

    const allDay = await ds.query(`SELECT count(*) AS n FROM economic_events WHERE source IS NOT NULL AND NOT all_day`);
    expect(Number(allDay[0].n)).toBe(0);

    // The calendar API lists an all-day event for the whole of its day (here: the FOMC decision day)
    const calendar = new EconomicCalendarService(ds.getRepository(EconomicEventEntity), {} as never);
    const listed = await calendar.getUpcomingEvents('USD', new Date('2026-10-28T18:30:00Z'));
    expect(listed[0]).toMatchObject({ title: 'FOMC meeting, October 27-28', allDay: true, source: 'FOMC', impact: 'HIGH' });
    expect(listed[0].forecast).toBeNull();
  });
});
