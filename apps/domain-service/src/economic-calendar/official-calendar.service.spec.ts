import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource, EntityManager } from 'typeorm';
import type Redis from 'ioredis';
import { EconomicEventEntity } from '@forexedge/database';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import {
  OfficialCalendarService, claimKey, describeFailure, fetchPage, type FetchedPage, type PageFetcher,
} from './official-calendar.service';
import { EconomicCalendarService } from './economic-calendar.service';
import { CALENDAR_USER_AGENT, OFFICIAL_SOURCES } from './official-sources';
import { parseEcbCalendar } from './ecb.parser';
import { parseFomcCalendar } from './fomc.parser';
import { FOREXFACTORY } from './forexfactory/forexfactory.source';
import { parseForexFactoryWeek } from './forexfactory/forexfactory.parser';

// The recorded pages (__fixtures__/README.md, forexfactory/__fixtures__/README.md) stand in for the network:
// the default suite never fetches anything. The Forex Factory content type is the one recorded with it.
const FIXTURES = join(__dirname, '__fixtures__');
const FF_BODY = readFileSync(join(__dirname, 'forexfactory', '__fixtures__', 'ff_calendar_thisweek-2026-11-06.json'), 'utf8');
const PAGES: Record<string, FetchedPage> = {
  [OFFICIAL_SOURCES.FOMC.url]: { status: 200, contentType: 'text/html', body: readFileSync(join(FIXTURES, 'fomccalendars.htm'), 'utf8') },
  [OFFICIAL_SOURCES.ECB.url]: { status: 200, contentType: 'text/html', body: readFileSync(join(FIXTURES, 'ecb-mgcgc-index.en.html'), 'utf8') },
  [FOREXFACTORY.url]: { status: 200, contentType: 'application/json', body: FF_BODY },
};
const NOW = new Date('2026-11-06T09:00:00Z');

const FOMC_COUNT = parseFomcCalendar(PAGES[OFFICIAL_SOURCES.FOMC.url].body).length;
const ECB_COUNT = parseEcbCalendar(PAGES[OFFICIAL_SOURCES.ECB.url].body).length;
const FF_WEEK = parseForexFactoryWeek(FF_BODY, 'application/json');

const recordedFetcher = () =>
  jest.fn<ReturnType<PageFetcher>, Parameters<PageFetcher>>(async (url) => PAGES[url]);

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

  it('fetches each source once with the plain ForexEdge User-Agent and stores every event at its UTC time', async () => {
    expect([FOMC_COUNT, ECB_COUNT, FF_WEEK.events.length].every((n) => n > 0)).toBe(true);
    const { service, queries } = setup();
    const outcomes = await service.syncAll(NOW);
    expect(outcomes).toEqual([
      { source: 'FOMC', outcome: 'synced', events: FOMC_COUNT },
      { source: 'ECB', outcome: 'synced', events: ECB_COUNT },
      { source: 'FOREXFACTORY', outcome: 'synced', events: 112 },
    ]);
    expect((service.fetcher as jest.Mock).mock.calls).toEqual([
      [OFFICIAL_SOURCES.FOMC.url, CALENDAR_USER_AGENT],
      [OFFICIAL_SOURCES.ECB.url, CALENDAR_USER_AGENT],
      ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', CALENDAR_USER_AGENT],
    ]);
    expect(CALENDAR_USER_AGENT).toBe('ForexEdge (+https://github.com/aakash1514/algo_trading_forex)');

    // FOMC/ECB replace from today on; Forex Factory replaces exactly its week
    const deletes = queries.filter(([sql]) => sql.startsWith('DELETE'));
    expect(deletes).toEqual([
      ['DELETE FROM economic_events WHERE source = $1 AND scheduled_at >= $2', ['FOMC', '2026-11-06T00:00:00.000Z']],
      ['DELETE FROM economic_events WHERE source = $1 AND scheduled_at >= $2', ['ECB', '2026-11-06T00:00:00.000Z']],
      ['DELETE FROM economic_events WHERE source = $1 AND scheduled_at BETWEEN $2 AND $3',
        ['FOREXFACTORY', '2026-11-01T07:00:00.000Z', '2026-11-06T21:45:00.000Z']],
    ]);
    const inserts = queries.filter(([sql]) => sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(FOMC_COUNT + ECB_COUNT + 112);
    expect(inserts[0][0]).toContain('VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (source, scheduled_at, currency, title) DO NOTHING');
    expect(inserts.find(([, p]) => p[0] === 'FOMC meeting, October 27-28')?.[1])
      .toEqual(['FOMC meeting, October 27-28', 'USD', 'HIGH', '2026-10-28T18:00:00.000Z', 'expected', 'FOMC']);
    expect(inserts.find(([, p]) => p[0] === 'RBA Rate Statement')?.[1])
      .toEqual(['RBA Rate Statement', 'AUD', 'HIGH', '2026-11-03T03:30:00.000Z', 'third_party', 'FOREXFACTORY']);
  });

  it('fetches FOMC and ECB at most once per UTC day and Forex Factory at most twice (06:15 and 18:15 slots)', async () => {
    const { service, redis } = setup();
    await service.syncAll(new Date('2026-11-06T06:15:00Z'));           // the morning cron
    await service.syncAll(new Date('2026-11-06T11:59:59Z'));           // a restart before noon
    expect(service.fetcher).toHaveBeenCalledTimes(3);
    await service.syncSource('FOREXFACTORY', new Date('2026-11-06T18:15:00Z')); // the evening cron
    await service.syncAll(new Date('2026-11-06T23:59:00Z'));           // a restart in the evening
    const calls = (service.fetcher as jest.Mock).mock.calls.map(([url]) => url);
    expect(calls.filter((u) => u === FOREXFACTORY.url)).toHaveLength(2);
    expect(calls.filter((u) => u === OFFICIAL_SOURCES.FOMC.url)).toHaveLength(1);
    expect(calls).toHaveLength(4);
    expect([...redis.keys.keys()].sort()).toEqual([
      'calendar:fetched:ECB:2026-11-06', 'calendar:fetched:FOMC:2026-11-06',
      'calendar:fetched:FOREXFACTORY:2026-11-06:am', 'calendar:fetched:FOREXFACTORY:2026-11-06:pm',
    ]);
    expect(redis.set).toHaveBeenCalledWith('calendar:fetched:FOMC:2026-11-06', '2026-11-06T06:15:00.000Z', 'EX', 172_800, 'NX');

    await service.syncAll(new Date('2026-11-07T06:15:00Z'));           // the next day
    expect(service.fetcher).toHaveBeenCalledTimes(7);
  });

  it('the 18:15 cron syncs Forex Factory only', async () => {
    const { service } = setup();
    const spy = jest.spyOn(service, 'syncSource').mockResolvedValue({ source: 'FOREXFACTORY', outcome: 'skipped' });
    await service.scheduledEveningSync();
    expect(spy.mock.calls).toEqual([['FOREXFACTORY']]);
  });

  it('claim keys: one per date, or per half day for Forex Factory', () => {
    expect(claimKey('ECB', new Date('2026-11-06T23:00:00Z'))).toBe('calendar:fetched:ECB:2026-11-06');
    expect(claimKey('FOREXFACTORY', new Date('2026-11-06T11:59:59Z'))).toBe('calendar:fetched:FOREXFACTORY:2026-11-06:am');
    expect(claimKey('FOREXFACTORY', new Date('2026-11-06T12:00:00Z'))).toBe('calendar:fetched:FOREXFACTORY:2026-11-06:pm');
  });

  it.each<[string, FetchedPage, string]>([
    ['403', { status: 403, contentType: 'text/html', body: 'Forbidden' }, 'HTTP 403'],
    ['429', { status: 429, contentType: 'text/html', body: 'Too Many Requests' }, 'HTTP 429'],
    ['a challenge page answered with 200', { status: 200, contentType: 'text/html; charset=UTF-8',
      body: '<!DOCTYPE html><title>Just a moment...</title>' }, 'ForexFactory: not JSON (content type text/html; charset=UTF-8)'],
    ['a body that is not JSON', { status: 200, contentType: 'application/json', body: 'not json' },
      'ForexFactory: the body is not valid JSON'],
    ['an empty export', { status: 200, contentType: 'application/json', body: '[]' }, 'ForexFactory: the export is empty'],
  ])('Forex Factory %s: one fetch, nothing written, the last good events kept', async (_name, response, reason) => {
    const { service, dataSource } = setup();
    service.fetcher = jest.fn(async () => response);
    expect(await service.syncSource('FOREXFACTORY', NOW)).toEqual({ source: 'FOREXFACTORY', outcome: 'kept', reason });
    expect(service.fetcher).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    // no retry in the same slot
    expect(await service.syncSource('FOREXFACTORY', NOW)).toEqual({ source: 'FOREXFACTORY', outcome: 'skipped' });
    expect(service.fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good events (writes nothing) on an HTTP error or a page it cannot parse', async () => {
    const { service, dataSource } = setup();
    service.fetcher = jest.fn(async (url: string) =>
      url === OFFICIAL_SOURCES.FOMC.url ? { status: 403, contentType: 'text/html', body: 'Access Denied' }
        : { ...PAGES[url], body: PAGES[url].body.replace(/<dl>/, '<dl class="changed">').replace(/^\[/, '{') });
    const outcomes = await service.syncAll(NOW);
    expect(outcomes).toEqual([
      { source: 'FOMC', outcome: 'kept', reason: 'HTTP 403' },
      { source: 'ECB', outcome: 'kept', reason: 'ECB: meeting schedule list not found' },
      { source: 'FOREXFACTORY', outcome: 'kept', reason: 'ForexFactory: the body is not valid JSON' },
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

  const bySource = async () => testDb.dataSource.query(
    `SELECT source, time_source, count(*)::int AS n FROM economic_events GROUP BY 1, 2 ORDER BY 1, 2`);
  const sync = async (fetcher: PageFetcher, ds: DataSource = testDb.dataSource) => {
    const service = new OfficialCalendarService(ds, fakeRedis() as unknown as Redis);
    service.fetcher = fetcher;
    return service.syncAll(NOW);
  };

  it('stores the recorded calendars at their UTC times, resyncs idempotently, keeps them on a failure', async () => {
    const ds = testDb.dataSource;
    await sync(recordedFetcher());
    const expected = [
      { source: 'ECB', time_source: 'official', n: ECB_COUNT },
      { source: 'FOMC', time_source: 'expected', n: FOMC_COUNT },
      { source: 'FOREXFACTORY', time_source: 'third_party', n: 112 },
    ];
    expect(await bySource()).toEqual(expected);

    await sync(recordedFetcher());
    expect(await bySource()).toEqual(expected);

    await sync(jest.fn(async () => ({ status: 503, contentType: 'text/html', body: '' })));
    expect(await bySource()).toEqual(expected);

    // The calendar API lists events from the given instant on, with their UTC time and its source
    const calendar = new EconomicCalendarService(ds.getRepository(EconomicEventEntity), {} as never);
    const listed = await calendar.getUpcomingEvents('USD', new Date('2026-12-09T19:00:00Z'));
    expect(listed[0]).toMatchObject({ title: 'FOMC meeting, December 8-9, with Summary of Economic Projections', timeSource: 'expected', source: 'FOMC' });
    expect(new Date(listed[0].scheduledAt).toISOString()).toBe('2026-12-09T19:00:00.000Z');
    expect(listed[0].forecast).toBeNull();
    const ff = await calendar.getUpcomingEvents('CAD', new Date('2026-11-06T13:30:00Z'));
    const unemployment = ff.find((e) => e.title === 'Unemployment Rate');
    expect(unemployment && [unemployment.impact, unemployment.timeSource, unemployment.forecast, unemployment.previous,
      new Date(unemployment.scheduledAt).toISOString()]).toEqual(['HIGH', 'third_party', null, null, '2026-11-06T13:30:00.000Z']);
  });

  it('replaces the Forex Factory week in one transaction: a failure part-way leaves the stored week untouched', async () => {
    const ds = testDb.dataSource;
    const ids = async () => (await ds.query(
      `SELECT id FROM economic_events WHERE source = 'FOREXFACTORY' ORDER BY id`)).map((r: { id: string }) => r.id);
    const before = await ids();
    expect(before).toHaveLength(112);

    // a DataSource whose 50th insert fails, after the week's DELETE and 49 inserts in the same transaction
    let inserts = 0;
    const failing = {
      transaction: (cb: (m: EntityManager) => Promise<void>) => ds.transaction((manager) => cb(new Proxy(manager, {
        get: (target, prop, receiver) => prop !== 'query' ? Reflect.get(target, prop, receiver)
          : async (sql: string, params?: unknown[]) => {
            if (sql.trim().startsWith('INSERT') && ++inserts === 50) throw new Error('insert 50 failed');
            return target.query(sql, params);
          },
      }))),
    } as unknown as DataSource;
    const service = new OfficialCalendarService(failing, fakeRedis() as unknown as Redis);
    service.fetcher = recordedFetcher();
    expect(await service.syncSource('FOREXFACTORY', NOW))
      .toEqual({ source: 'FOREXFACTORY', outcome: 'kept', reason: 'insert 50 failed' });
    expect(inserts).toBe(50);
    expect(await ids()).toEqual(before);
  });
});
