// The replay clock against a real database: <DB_NAME>_test with the real Dukascopy
// EUR/USD minutes of Monday 2022-01-03 (00:00-23:59 UTC; the New York close at 22:00
// UTC is a D1 and an H4 boundary), the services connected as a login with
// forexedge_replay's grants. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=playback.db.spec.ts --skip-nx-cache
import { HISTORICAL_SOURCES, HistoricalTimeframe, historicalBucketSql, ReplayPositionEntity, ReplaySessionEntity }
  from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb } from '../../test/replay-test-db';
import { SessionLock } from '../engine/session-lock';
import { PairContextService } from '../history/pair-context.service';
import { ReplaySessionService } from '../session/session.service';
import { PlaybackService, ReplayCommandError } from './playback.service';
import { ReplayEmitter } from './replay-emitter';
import { ReplayStateService } from './replay-state.service';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

// Records what would go to the sockets (after the emitter's own no-future check)
class RecordingEmitter extends ReplayEmitter {
  readonly events: { userId: string; event: string; payload: unknown; clock: Date }[] = [];
  override toUser(userId: string, event: string, payload: unknown, clock: Date): void {
    super.toUser(userId, event, payload, clock);
    this.events.push({ userId, event, payload: JSON.parse(JSON.stringify(payload)), clock });
  }
}

type Bar = { time: string; minutes: number; bid: Record<string, string>; ask: Record<string, string> };
const waitFor = async (check: () => Promise<boolean>, timeoutMs: number) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

run('replay playback (real DB, real minutes, replay login)', () => {
  jest.setTimeout(180_000);
  let db: ReplayTestDb;
  let sessions: ReplaySessionService;
  let playback: PlaybackService;
  let emitter: RecordingEmitter;

  const newPlayback = () => {
    const pairs = new PairContextService(db.replay);
    return new PlaybackService(
      db.replay.getRepository(ReplaySessionEntity), db.replay, pairs, new SessionLock(), emitter,
      new ReplayStateService(db.replay.getRepository(ReplayPositionEntity), db.replay, pairs));
  };
  const start = async (startTime: string, timeframe: string) => {
    const userId = await db.createUser();
    const session = await sessions.create(userId, { instrument: 'EUR_USD', startTime, timeframe } as never);
    return { userId, session };
  };
  const session = (userId: string) => db.admin.getRepository(ReplaySessionEntity).findOneByOrFail({ userId });
  // The bar of `timeframe` holding `time`, rebuilt from M1 minutes up to `upTo`, as decimal text
  const rebuilt = async (timeframe: HistoricalTimeframe, time: string, upTo: string) => {
    const b = historicalBucketSql(timeframe, 'time');
    const [r] = await db.admin.query(`
      SELECT ${b} AS bucket, count(*)::int AS minutes,
             (array_agg(bid_open ORDER BY time))[1] AS bo, max(bid_high) AS bh, min(bid_low) AS bl,
             (array_agg(bid_close ORDER BY time DESC))[1] AS bc
        FROM historical_candles WHERE pair = 'EUR/USD' AND ${b} = ${historicalBucketSql(timeframe, '$1::timestamptz')}
         AND time <= $2 GROUP BY 1`, [time, upTo]);
    return r;
  };
  const aggregate = async (timeframe: HistoricalTimeframe, bucket: string) => {
    const [r] = await db.admin.query(
      `SELECT bucket, minutes::int AS minutes, bid_open AS bo, bid_high AS bh, bid_low AS bl, bid_close AS bc
         FROM ${HISTORICAL_SOURCES[timeframe].table} WHERE pair = 'EUR/USD' AND bucket = $1`, [bucket]);
    return r;
  };
  const text = (points: number) => (points / 1e5).toFixed(5);

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03]);
    emitter = new RecordingEmitter();
    sessions = new ReplaySessionService(
      db.replay.getRepository(ReplaySessionEntity), db.replay, new PairContextService(db.replay), new SessionLock());
    playback = newPlayback();
  });

  afterAll(async () => {
    await playback?.onModuleDestroy();
    await db?.close();
  });

  it.each(['5m', '15m', '1h', '4h', '1d'] as HistoricalTimeframe[])(
    'the %s bucket SQL rebuilds every aggregate row from the real minutes', async (timeframe) => {
      const b = historicalBucketSql(timeframe, 'time');
      const fromM1 = await db.admin.query(`
        SELECT ${b} AS bucket, count(*)::int AS minutes,
               (array_agg(bid_open ORDER BY time))[1] AS bid_open, max(bid_high) AS bid_high, min(bid_low) AS bid_low,
               (array_agg(bid_close ORDER BY time DESC))[1] AS bid_close,
               (array_agg(ask_open ORDER BY time))[1] AS ask_open, max(ask_high) AS ask_high, min(ask_low) AS ask_low,
               (array_agg(ask_close ORDER BY time DESC))[1] AS ask_close
          FROM historical_candles WHERE pair = 'EUR/USD' GROUP BY 1 ORDER BY 1`);
      const view = await db.admin.query(`
        SELECT bucket, minutes::int AS minutes, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close
          FROM ${HISTORICAL_SOURCES[timeframe].table} WHERE pair = 'EUR/USD' ORDER BY bucket`);
      expect(view.length).toBeGreaterThan(0);
      expect(fromM1).toEqual(view);
    });

  it('a step on H1 from mid-hour processes the rest of that hour, then whole hours', async () => {
    const { userId, session: s } = await start('2022-01-03T09:30Z', '1h');
    const state = await playback.connected(userId);
    // Before stepping: the current bar holds only the minutes up to 09:30
    const partial = await rebuilt('1h', '2022-01-03T09:00Z', s.clockTime);
    const full = await aggregate('1h', '2022-01-03T09:00Z');
    expect(state?.currentBar).toMatchObject({
      time: '2022-01-03T09:00:00.000Z', lastMinute: s.clockTime, minutes: partial.minutes, bid: { open: text(partial.bo), close: text(partial.bc) },
    });
    expect(partial.minutes).toBeLessThan(full.minutes);
    expect(state?.bars.length).toBeGreaterThan(0);
    for (const bar of state?.bars ?? []) expect(Date.parse(bar.time)).toBeLessThan(Date.parse('2022-01-03T09:00Z'));

    emitter.events.length = 0;
    const first = await playback.step(userId);
    const [{ last }] = await db.admin.query(
      `SELECT max(time) AS last FROM historical_candles WHERE pair = 'EUR/USD' AND time < '2022-01-03T10:00Z'`);
    expect(first.session.clockTime).toBe(new Date(last).toISOString());
    expect(first.minutes).toBe(full.minutes - partial.minutes);
    // The completed bar, built from minutes, equals the aggregate row
    const bar = emitter.events.find((e) => e.event === 'bar')?.payload as { bar: Bar };
    expect(bar.bar).toMatchObject({ time: '2022-01-03T09:00:00.000Z', minutes: full.minutes,
      bid: { open: text(full.bo), high: text(full.bh), low: text(full.bl), close: text(full.bc) } });
    expect(emitter.events.map((e) => e.event)).toEqual(['bar', 'account']);

    const second = await playback.step(userId);
    const next = await aggregate('1h', '2022-01-03T10:00Z');
    expect(second.minutes).toBe(next.minutes);
    expect((await session(userId)).clockTime.toISOString()).toBe(second.session.clockTime);
    await sessions.end(userId);
  });

  it('D1 across the New York close: the Monday bar ends at 21:59 UTC, the next starts at 22:00', async () => {
    const { userId } = await start('2022-01-03T21:30Z', '1d');
    const state = await playback.connected(userId);
    expect(state?.currentBar.time).toBe('2022-01-02T22:00:00.000Z'); // 17:00 New York (EST) on Sunday
    const first = await playback.step(userId);
    expect(first.session.clockTime).toBe('2022-01-03T21:59:00.000Z');
    emitter.events.length = 0;
    const second = await playback.step(userId);
    const bar = emitter.events.find((e) => e.event === 'bar')?.payload as { bar: Bar };
    expect(bar.bar.time).toBe('2022-01-03T22:00:00.000Z');
    expect(Date.parse(second.session.clockTime)).toBeGreaterThan(Date.parse('2022-01-03T22:00Z'));
    // The fixture ends on this bar: the end of the data
    expect(second.endOfData).toBe(true);
    expect(emitter.events.map((e) => e.event)).toContain('endOfData');
    const third = await playback.step(userId);
    expect([third.minutes, third.endOfData, third.session.clockTime]).toEqual([0, true, second.session.clockTime]);
    await expect(playback.play(userId)).rejects.toThrow('End of data');
    await sessions.end(userId);
  });

  it('H4 buckets are New York-aligned: 14:00-17:59 then 18:00-21:59 UTC', async () => {
    const { userId } = await start('2022-01-03T17:30Z', '4h');
    expect((await playback.connected(userId))?.currentBar.time).toBe('2022-01-03T14:00:00.000Z');
    expect((await playback.step(userId)).session.clockTime).toBe('2022-01-03T17:59:00.000Z');
    emitter.events.length = 0;
    expect((await playback.step(userId)).session.clockTime).toBe('2022-01-03T21:59:00.000Z');
    const bar = emitter.events.find((e) => e.event === 'bar')?.payload as { bar: Bar };
    const agg = await aggregate('4h', '2022-01-03T18:00Z');
    expect(bar.bar).toMatchObject({ time: '2022-01-03T18:00:00.000Z', minutes: agg.minutes, bid: { close: text(agg.bc) } });
    await sessions.end(userId);
  });

  it('switching the timeframe resends the state on the new bars, from minutes up to the clock', async () => {
    const { userId } = await start('2022-01-03T13:47Z', '1m');
    await playback.connected(userId);
    for (const timeframe of ['5m', '15m', '1h', '4h', '1d'] as HistoricalTimeframe[]) {
      const state = await playback.setTimeframe(userId, timeframe);
      const expected = await rebuilt(timeframe, '2022-01-03T13:47Z', '2022-01-03T13:47Z');
      expect(state.currentBar).toMatchObject({ minutes: expected.minutes, lastMinute: '2022-01-03T13:47:00.000Z',
        bid: { open: text(expected.bo), high: text(expected.bh), low: text(expected.bl), close: text(expected.bc) } });
      expect(state.session.timeframe).toBe(timeframe);
    }
    await expect(playback.setTimeframe(userId, '2h')).rejects.toThrow('timeframe must be one of');
    await sessions.end(userId);
  });

  it('accepts only 500, 1000 and 2000 ms per bar', async () => {
    const { userId } = await start('2022-01-03T09:30Z', '1m');
    for (const bad of [750, 250, 0.5, 1, 2, 3000, '1000', null, undefined, NaN]) {
      await expect(playback.setSpeed(userId, bad)).rejects.toBeInstanceOf(ReplayCommandError);
    }
    for (const ok of [500, 2000, 1000]) {
      expect((await playback.setSpeed(userId, ok)).speedMs).toBe(ok);
      expect((await session(userId)).speedMs).toBe(ok);
    }
    await sessions.end(userId);
  });

  it('plays a bar per speed tick, refuses to step while playing, and pause stops the clock', async () => {
    const { userId } = await start('2022-01-03T09:00Z', '1m');
    await playback.setSpeed(userId, 500);
    const before = (await session(userId)).clockTime.getTime();
    expect((await playback.play(userId)).status).toBe('PLAYING');
    await expect(playback.step(userId)).rejects.toThrow('Pause before stepping');
    expect(await waitFor(async () => (await session(userId)).clockTime.getTime() >= before + 2 * 60_000, 5_000)).toBe(true);
    expect((await playback.pause(userId)).status).toBe('PAUSED');
    const paused = (await session(userId)).clockTime.getTime();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await session(userId)).clockTime.getTime()).toBe(paused);
    expect((await session(userId)).status).toBe('PAUSED');
    await sessions.end(userId);
  });

  it('the last socket leaving pauses and saves; a connecting socket always finds it PAUSED', async () => {
    const { userId } = await start('2022-01-03T09:00Z', '1m');
    await playback.play(userId);
    await playback.lastSocketLeft(userId);
    expect((await session(userId)).status).toBe('PAUSED');
    await playback.play(userId);
    const state = await playback.connected(userId);
    expect(state?.session.status).toBe('PAUSED');
    expect((await session(userId)).status).toBe('PAUSED');
    await sessions.end(userId);
  });

  it('a boot pauses every PLAYING session and never resumes one', async () => {
    const { userId } = await start('2022-01-03T09:00Z', '1m');
    await db.admin.query(`UPDATE replay_sessions SET status = 'PLAYING' WHERE user_id = $1`, [userId]);
    const clock = (await session(userId)).clockTime.getTime();
    const booted = newPlayback();
    await booted.onModuleInit();
    expect((await session(userId)).status).toBe('PAUSED');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await session(userId)).clockTime.getTime()).toBe(clock);
    await booted.onModuleDestroy();
    await sessions.end(userId);
  });

  it('every event sent had no market time after its clock', () => {
    expect(emitter.events.length).toBeGreaterThan(0);
    let checked = 0;
    // The emitter refuses such a payload before recording it; check the record independently
    for (const e of emitter.events) {
      const json = JSON.stringify(e.payload);
      for (const [, , t] of json.matchAll(/"(time|lastMinute|clockTime|entryTime|exitTime|placedAt|exitRequestedAt)":"([^"]+)"/g)) {
        checked++;
        expect(Date.parse(t)).toBeLessThanOrEqual(e.clock.getTime());
      }
    }
    expect(checked).toBeGreaterThan(emitter.events.length);
  });
});
