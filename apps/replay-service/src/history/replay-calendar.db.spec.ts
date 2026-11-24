// Calendar events on the replay chart against a real database: <DB_NAME>_test with the
// real EUR/USD minutes around the FOMC decision of 2022-01-26 19:00 UTC (cut at run time
// from the local Dukascopy export, data/raw/jforex/EURUSD/2022.csv, which is not in the
// repository: the spec is skipped without it) and the real FOMC and ECB events
// (domain-service's parsers over its recorded official pages), read as a login with
// forexedge_replay's grants. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=replay-calendar.db.spec.ts --skip-nx-cache
import { HistoricalTimeframe, ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_26_FOMC, hasLocalExport, ReplayTestDb } from '../../test/replay-test-db';
import { SessionLock } from '../engine/session-lock';
import { PlaybackService } from '../playback/playback.service';
import { ReplayEmitter } from '../playback/replay-emitter';
import { ReplayStateService } from '../playback/replay-state.service';
import { ReplaySessionService } from '../session/session.service';
import { PairContextService } from './pair-context.service';
import { calendarCovered, calendarCurrencies, calendarEvents } from './replay-calendar';

const run = process.env['RUN_DB_TESTS'] === 'true' && hasLocalExport(EURUSD_2022_01_26_FOMC) ? describe : describe.skip;
if (process.env['RUN_DB_TESTS'] === 'true' && !hasLocalExport(EURUSD_2022_01_26_FOMC)) {
  console.warn(`replay-calendar.db.spec skipped: no local export data/raw/jforex/${EURUSD_2022_01_26_FOMC.file}`);
}

class RecordingEmitter extends ReplayEmitter {
  readonly events: { event: string; payload: unknown; clock: Date }[] = [];
  override toUser(userId: string, event: string, payload: unknown, clock: Date): void {
    super.toUser(userId, event, payload, clock);
    this.events.push({ event, payload: JSON.parse(JSON.stringify(payload)), clock });
  }
}

const FOMC_TIME = '2022-01-26T19:00:00.000Z';
const FOMC_TITLE = 'FOMC meeting, January 25-26';
const at = (iso: string) => new Date(iso);
const TIMEFRAMES: HistoricalTimeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
// The bar holding 19:00 UTC on 2022-01-26: H4 and D1 follow the New York close (17:00 EST = 22:00 UTC)
const FOMC_BAR: Record<HistoricalTimeframe, string> = {
  '1m': FOMC_TIME, '5m': FOMC_TIME, '15m': FOMC_TIME, '1h': FOMC_TIME,
  '4h': '2022-01-26T18:00:00.000Z', '1d': '2022-01-25T22:00:00.000Z',
};

run('replay calendar (real DB, real FOMC/ECB events, replay login)', () => {
  jest.setTimeout(180_000);
  let db: ReplayTestDb;

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_26_FOMC]);
  });
  afterAll(async () => {
    await db?.close();
  });

  const january = (timeframe: HistoricalTimeframe, clock: string) =>
    calendarEvents(db.replay, calendarCurrencies('EUR/USD'), timeframe, { after: null, from: at('2022-01-01T00:00Z'), upTo: at(clock) });

  it.each(TIMEFRAMES)('%s: the 19:00 decision is not sent at 18:59, even inside its own bar', async (timeframe) => {
    expect(await january(timeframe, '2022-01-26T18:59Z')).toEqual([]);
  });

  it.each(TIMEFRAMES)('%s: at 19:00 it is sent, on the bar that holds 19:00', async (timeframe) => {
    const events = await january(timeframe, '2022-01-26T19:00Z');
    expect(events).toEqual([expect.objectContaining({
      time: FOMC_TIME, barTime: FOMC_BAR[timeframe], title: FOMC_TITLE, currency: 'USD', impact: 'HIGH',
      source: 'FOMC', timeSource: 'expected', actual: null, forecast: null, previous: null,
    })]);
  });

  it('only the pair’s currencies: EUR/USD gets FOMC and ECB, USD/JPY and XAU/USD only FOMC', async () => {
    const all = async (pair: string) => calendarEvents(db.replay, calendarCurrencies(pair), '1h',
      { after: null, from: null, upTo: at('2100-01-01T00:00Z') });
    const counts = async (pair: string) => {
      const sources: Record<string, number> = {};
      for (const e of await all(pair)) sources[`${e.source} ${e.currency}`] = (sources[`${e.source} ${e.currency}`] ?? 0) + 1;
      return sources;
    };
    const [stored] = await db.admin.query(
      `SELECT count(*) FILTER (WHERE source = 'FOMC')::int AS fomc, count(*) FILTER (WHERE source = 'ECB')::int AS ecb
         FROM economic_events WHERE impact IN ('HIGH', 'MEDIUM')`);
    expect(stored.fomc).toBeGreaterThan(0);
    expect(stored.ecb).toBeGreaterThan(0);
    expect(await counts('EUR/USD')).toEqual({ 'FOMC USD': stored.fomc, 'ECB EUR': stored.ecb });
    expect(await counts('USD/JPY')).toEqual({ 'FOMC USD': stored.fomc });
    expect(await counts('XAU/USD')).toEqual({ 'FOMC USD': stored.fomc });
  });

  it('covered: false before the first stored event, true from its time', async () => {
    const [{ first }] = await db.admin.query(`SELECT min(scheduled_at) AS first FROM economic_events WHERE currency = 'USD'`);
    const firstMs = new Date(first).getTime();
    expect(await calendarCovered(db.replay, ['USD', 'JPY'], new Date(firstMs - 60_000))).toBe(false);
    expect(await calendarCovered(db.replay, ['USD', 'JPY'], new Date(firstMs))).toBe(true);
  });

  it('a session: no event in the state before 19:00, none sent at 18:59, the event in the 19:00 step', async () => {
    const pairs = new PairContextService(db.replay);
    const emitter = new RecordingEmitter();
    const sessions = new ReplaySessionService(db.replay.getRepository(ReplaySessionEntity), db.replay, pairs, new SessionLock());
    const state = new ReplayStateService(db.replay.getRepository(ReplayPositionEntity), db.replay, pairs);
    const playback = new PlaybackService(
      db.replay.getRepository(ReplaySessionEntity), db.replay, pairs, new SessionLock(), emitter, state);
    const userId = await db.createUser();
    try {
      const created = await sessions.create(userId, { instrument: 'EUR_USD', startTime: '2022-01-26T18:58Z', timeframe: '1m' } as never);
      const session = () => db.admin.getRepository(ReplaySessionEntity).findOneByOrFail({ userId });
      const first = await state.state(await session());
      expect(first.session.clockTime).toBe('2022-01-26T18:58:00.000Z');
      expect(first.calendar).toEqual({ covered: true, events: [] }); // FOMC events exist since 2021, none in view yet

      await playback.step(userId, created.id); // 18:59
      expect(emitter.events.map((e) => e.event)).not.toContain('calendar');
      await playback.step(userId, created.id); // 19:00
      const sent = emitter.events.filter((e) => e.event === 'calendar');
      expect(sent).toHaveLength(1);
      expect(sent[0].clock.toISOString()).toBe(FOMC_TIME);
      expect(sent[0].payload).toMatchObject({
        clockTime: FOMC_TIME, timeframe: '1m', events: [{ time: FOMC_TIME, barTime: FOMC_TIME, title: FOMC_TITLE }],
      });

      await playback.setTimeframe(userId, created.id, '4h');
      const reloaded = emitter.events.filter((e) => e.event === 'state').at(-1)?.payload as { calendar: unknown };
      expect(reloaded.calendar).toEqual({
        covered: true, events: [expect.objectContaining({ time: FOMC_TIME, barTime: FOMC_BAR['4h'] })],
      });
      await playback.step(userId, created.id); // 19:01: the event is not sent again
      expect(emitter.events.filter((e) => e.event === 'calendar')).toHaveLength(1);
    } finally {
      await playback.onModuleDestroy();
      await sessions.end(userId, (await sessions.getActive(userId)).id);
    }
  });
});
