// No future data, through the real app and socket, on the real EUR/USD minutes of
// Monday 2022-01-03 (its 22:00 UTC New York close is a D1 and an H4 boundary).
// One session is driven through steps, an order, timeframe switches (1h, 1d, 4h, 15m,
// 1d), play, a disconnect and a reconnect, across the 18:00 and 22:00 H4 boundaries
// and the 22:00 D1 boundary, to the end of the data. Then every event the client
// received is checked independently of the server's own guard:
//   - no market time (bar times, last minutes, fills, exits, placements) after the
//     clock the event carries (or the latest one received before it)
//   - every current bar equals its M1 rebuild up to the clock; when its bucket is
//     unfinished it holds fewer minutes than the aggregate row (which is never sent)
//   - every history bar equals its aggregate row and starts before the current bar
// Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=no-future-data.db.spec.ts --skip-nx-cache
import { HISTORICAL_SOURCES, HistoricalTimeframe, historicalBucketSql } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb } from '../../test/replay-test-db';
import { accessToken, connectClient, http, Received, ReplayApp, startReplayApp } from '../../test/replay-app';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Ohlc { open: string; high: string; low: string; close: string }
interface Bar { time: string; lastMinute: string | null; minutes: number; bid: Ohlc; ask: Ohlc }

const MARKET_TIMES = new Set(['time', 'lastMinute', 'clockTime', 'entryTime', 'exitTime', 'placedAt', 'exitRequestedAt']);

// [path, time] of every market time in a payload
function marketTimes(value: unknown, path = '$'): [string, number][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => marketTimes(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => (MARKET_TIMES.has(k) && typeof v === 'string'
    ? [[`${path}.${k}`, Date.parse(v)] as [string, number]] : marketTimes(v, `${path}.${k}`)));
}

// The fields of the replay events this suite reads
interface Payload {
  session?: { clockTime: string; timeframe: HistoricalTimeframe } | null;
  clockTime?: string;
  timeframe?: HistoricalTimeframe;
  currentBar?: Bar;
  bar?: Bar;
}

// The clock an event states, if it states one
function clockOf(e: Received): number | null {
  const p = e.payload as Payload;
  if (e.event === 'state' || e.event === 'ended') return p.session ? Date.parse(p.session.clockTime) : null;
  if (['bar', 'account', 'status', 'endOfData'].includes(e.event)) return Date.parse(p.clockTime as string);
  return null;
}

run('no future data (real app, real minutes, H4 and D1 boundaries)', () => {
  jest.setTimeout(240_000);
  let db: ReplayTestDb;
  let app: ReplayApp;
  const received: Received[] = [];

  const text = (points: number) => (points / 1e5).toFixed(5);
  const asBar = (r: Record<string, number>) => ({
    bid: { open: text(r['bo']), high: text(r['bh']), low: text(r['bl']), close: text(r['bc']) },
    ask: { open: text(r['ao']), high: text(r['ah']), low: text(r['al']), close: text(r['ac']) },
  });
  // The bar of `timeframe` starting at `bucket`, rebuilt from its M1 minutes up to `clock`
  const rebuild = async (timeframe: HistoricalTimeframe, bucket: string, clock: number) => {
    const b = historicalBucketSql(timeframe, 'time');
    const [r] = await db.admin.query(`
      SELECT count(*)::int AS minutes, max(time) AS last,
             (array_agg(bid_open ORDER BY time))[1] AS bo, max(bid_high) AS bh, min(bid_low) AS bl, (array_agg(bid_close ORDER BY time DESC))[1] AS bc,
             (array_agg(ask_open ORDER BY time))[1] AS ao, max(ask_high) AS ah, min(ask_low) AS al, (array_agg(ask_close ORDER BY time DESC))[1] AS ac
        FROM historical_candles WHERE pair = 'EUR/USD' AND ${b} = $1::timestamptz AND time <= $2`, [bucket, new Date(clock)]);
    return r;
  };
  const aggregate = async (timeframe: HistoricalTimeframe, bucket: string) => {
    const [r] = await db.admin.query(`
      SELECT minutes::int AS minutes, bid_open AS bo, bid_high AS bh, bid_low AS bl, bid_close AS bc,
             ask_open AS ao, ask_high AS ah, ask_low AS al, ask_close AS ac
        FROM ${HISTORICAL_SOURCES[timeframe].table} WHERE pair = 'EUR/USD' AND bucket = $1`, [bucket]);
    return r;
  };

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03]);
    app = await startReplayApp(db);

    const userId = await db.createUser();
    const token = accessToken(userId);
    const created = await http<{ id: string }>(app.url, token, 'POST', '/sessions',
      { instrument: 'EUR_USD', startTime: '2022-01-03T16:10Z', timeframe: '1h' });
    expect(created.status).toBe(201);
    const sessionId = created.body.id;

    const a = await connectClient(app.url, token);
    const ok = async (name: string, body?: object) => expect((await a.command(name, { sessionId, ...body })).ok).toBe(true);
    await ok('step');                                      // 1h: 16:11-16:59
    await ok('step');                                      // 1h: 17:00-17:59
    expect((await http(app.url, token, 'POST', `/sessions/${sessionId}/orders`, { side: 'BUY', lots: 0.1 })).status).toBe(201);
    await ok('setTimeframe', { timeframe: '1d' });         // D1 2022-01-02 22:00, unfinished at 17:59
    await ok('setTimeframe', { timeframe: '4h' });         // H4 14:00, complete at 17:59
    await ok('setTimeframe', { timeframe: '15m' });
    await ok('setSpeed', { speedMs: 500 });
    await ok('play');                                      // 15m bars from 18:00 (across the 18:00 H4 boundary)
    await sleep(2_300);
    await ok('pause');
    await ok('setTimeframe', { timeframe: '4h' });         // H4 18:00, unfinished
    await ok('step');                                      // H4: to 21:59
    received.push(...a.events);
    await a.close();

    const b = await connectClient(app.url, token);         // reconnect: PAUSED, full state
    const okB = async (name: string, body?: object) => expect((await b.command(name, { sessionId, ...body })).ok).toBe(true);
    await okB('setTimeframe', { timeframe: '1d' });        // D1 2022-01-02 22:00, now complete
    await okB('step');                                     // D1 2022-01-03 22:00: 22:00-23:59, the end of the data
    await okB('step');                                     // nothing left: endOfData again
    await sleep(200);
    expect((await http(app.url, token, 'POST', `/sessions/${sessionId}/end`)).status).toBe(200);
    await sleep(300);
    received.push(...b.events);
    await b.close();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it('received the whole session: states, bars across H4 and D1 boundaries, a fill, the end', () => {
    const count = (event: string) => received.filter((e) => e.event === event).length;
    expect(count('state')).toBeGreaterThanOrEqual(6);
    expect(count('bar')).toBeGreaterThanOrEqual(6);
    expect(count('positions')).toBeGreaterThanOrEqual(2);
    expect(count('endOfData')).toBeGreaterThanOrEqual(1);
    expect(count('ended')).toBe(1);
    const bars = received.filter((e) => e.event === 'bar').map((e) => (e.payload as { bar: Bar }).bar.time);
    expect(bars).toEqual(expect.arrayContaining(['2022-01-03T18:00:00.000Z', '2022-01-03T22:00:00.000Z']));
  });

  it('no market time in any event is after the clock', () => {
    let clock = -Infinity;
    let checked = 0;
    for (const e of received) {
      clock = clockOf(e) ?? clock;
      for (const [path, t] of marketTimes(e.payload)) {
        checked++;
        if (!(t <= clock)) throw new Error(`${e.event} ${path} ${new Date(t).toISOString()} is after the clock ${new Date(clock).toISOString()}`);
      }
    }
    expect(checked).toBeGreaterThan(received.length); // most events carry several market times
  });

  it('every current bar is its M1 rebuild up to the clock; unfinished ones never the aggregate', async () => {
    let compared = 0;
    let unfinished = 0;
    for (const e of received.filter((x) => x.event === 'state' || x.event === 'bar')) {
      const p = e.payload as Payload;
      if (e.event === 'state' && !p.session) continue;
      const timeframe = (e.event === 'state' ? p.session?.timeframe : p.timeframe) as HistoricalTimeframe;
      const clock = clockOf(e) as number;
      const bar = (e.event === 'state' ? p.currentBar : p.bar) as Bar;
      const rebuilt = await rebuild(timeframe, bar.time, clock);
      expect(bar).toEqual({ time: bar.time, lastMinute: new Date(rebuilt.last).toISOString(), minutes: rebuilt.minutes, ...asBar(rebuilt) });
      expect(Date.parse(bar.lastMinute as string)).toBe(clock);
      const full = await aggregate(timeframe, bar.time);
      if (rebuilt.minutes < full.minutes) {
        unfinished++;
        // What was sent is not the aggregate's (complete) row for that bucket
        expect({ minutes: bar.minutes, bid: bar.bid, ask: bar.ask }).not.toEqual({ minutes: full.minutes, ...asBar(full) });
      } else {
        expect(asBar(rebuilt)).toEqual(asBar(full)); // a finished bar is exactly its aggregate row
      }
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(12);
    expect(unfinished).toBeGreaterThanOrEqual(3); // D1 at 17:59, H4 18:00 after play, the opening states
  });

  it('every history bar is a completed aggregate row before the current bar', async () => {
    let compared = 0;
    for (const e of received.filter((x) => x.event === 'state' && (x.payload as Record<string, unknown>)['session'])) {
      const p = e.payload as { session: { timeframe: HistoricalTimeframe }; bars: Bar[]; currentBar: Bar };
      // Exactly the completed rows before the current bucket (up to 500): none is held back, none added
      const [{ n }] = await db.admin.query(
        `SELECT count(*)::int AS n FROM ${HISTORICAL_SOURCES[p.session.timeframe].table} WHERE pair = 'EUR/USD' AND bucket < $1`,
        [p.currentBar.time]);
      expect(p.bars.length).toBe(Math.min(500, n));
      for (const bar of p.bars) {
        expect(Date.parse(bar.time)).toBeLessThan(Date.parse(p.currentBar.time));
        expect(bar.lastMinute).toBeNull();
        const full = await aggregate(p.session.timeframe, bar.time);
        expect({ minutes: bar.minutes, bid: bar.bid, ask: bar.ask }).toEqual({ minutes: full.minutes, ...asBar(full) });
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});
