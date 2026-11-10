// Replay sessions against a real database: <DB_NAME>_test with the real instruments
// seed and the real Dukascopy EUR/USD and XAU/USD minutes of 2022-01-03, the
// services connected as a login with forexedge_replay's grants (test/replay-test-db.ts).
// Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=session.db.spec.ts --skip-nx-cache
import { ConflictException, NotFoundException } from '@nestjs/common';
import { closeQuote, entryFill, tradeMoney } from '@forexedge/trading-sim';
import { ReplaySessionEntity } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb, XAUUSD_2022_01_03 } from '../../test/replay-test-db';
import { SessionLock } from '../engine/session-lock';
import { PairContextService } from '../history/pair-context.service';
import { minuteAt } from '../history/replay-history';
import { ReplaySessionService } from './session.service';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

run('replay sessions (real DB, real history, replay login)', () => {
  jest.setTimeout(180_000);
  let db: ReplayTestDb;
  let service: ReplaySessionService;

  const create = (userId: string, over: Record<string, unknown> = {}) =>
    service.create(userId, { instrument: 'EUR_USD', startTime: '2022-01-03T09:30Z', timeframe: '1h', ...over } as never);

  // The first traded minute at or after a time, straight from the table
  const firstMinute = async (pair: string, at: string): Promise<Date | null> => {
    const [row] = await db.admin.query('SELECT min(time) AS t FROM historical_candles WHERE pair = $1 AND time >= $2', [pair, at]);
    return row.t ? new Date(row.t) : null;
  };

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03, XAUUSD_2022_01_03]);
    service = new ReplaySessionService(
      db.replay.getRepository(ReplaySessionEntity), db.replay, new PairContextService(db.replay), new SessionLock());
  });

  afterAll(async () => {
    await db?.close();
  });

  it('runs in a _test database with real minutes, as the replay login', async () => {
    expect(db.testDb.name).toMatch(/_test$/);
    const [{ n }] = await db.admin.query(`SELECT count(*)::int AS n FROM historical_candles WHERE pair = 'EUR/USD'`);
    expect(n).toBeGreaterThan(1000);
    const [{ user }] = await db.replay.query('SELECT current_user AS user');
    expect(user).toMatch(/^forexedge_replay_t/);
  });

  it('the replay login reads history and writes replay_* only', async () => {
    await expect(db.replay.query(`SELECT count(*) FROM historical_candles_1h`)).resolves.toBeDefined();
    for (const sql of [
      'INSERT INTO historical_candles SELECT * FROM historical_candles WHERE false',
      'DELETE FROM historical_candles WHERE false',
      'INSERT INTO ticks SELECT * FROM ticks WHERE false',
      'SELECT 1 FROM candles_1m',
      'SELECT 1 FROM users',
      'DELETE FROM replay_sessions WHERE false',
    ]) {
      await expect(db.replay.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('starts PAUSED on the first traded minute at or after the start, with the default balance', async () => {
    const userId = await db.createUser();
    const session = await create(userId);
    const expected = await firstMinute('EUR/USD', '2022-01-03T09:30Z');
    expect(expected).not.toBeNull();
    expect(session).toMatchObject({
      instrument: 'EUR_USD', status: 'PAUSED', pauseReason: null, speedMs: 1000, timeframe: '1h', endOfData: false,
      startTime: '2022-01-03T09:30:00.000Z', clockTime: expected?.toISOString(),
      startingBalance: '10000.00', balance: '10000.00', endedAt: null,
    });
    await service.end(userId);
  });

  it('a weekend start jumps to the next traded minute', async () => {
    const userId = await db.createUser();
    const session = await create(userId, { startTime: '2022-01-01T12:00Z', startingBalance: 2500.5 }); // a Saturday
    const expected = await firstMinute('EUR/USD', '2022-01-01T12:00Z');
    expect(new Date(expected as Date).getTime()).toBeGreaterThanOrEqual(Date.parse('2022-01-03T00:00Z'));
    expect(session.clockTime).toBe(expected?.toISOString());
    expect([session.startingBalance, session.balance]).toEqual(['2500.50', '2500.50']);
    await service.end(userId);
  });

  it('a start after the last traded minute sits on it, at the end of the data', async () => {
    const userId = await db.createUser();
    const session = await create(userId, { startTime: '2022-01-05T00:00Z' });
    const [{ t }] = await db.admin.query(`SELECT max(time) AS t FROM historical_candles WHERE pair = 'EUR/USD'`);
    expect(session.clockTime).toBe(new Date(t).toISOString());
    expect(session.endOfData).toBe(true);
    await service.end(userId);
  });

  it('allows one active session per user: 409 with the active id', async () => {
    const userId = await db.createUser();
    const first = await create(userId);
    const err = await create(userId, { instrument: 'XAU_USD' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ statusCode: 409, activeSessionId: first.id });
    expect((await service.getActive(userId)).id).toBe(first.id);
    await service.end(userId);
  });

  it('two creates at once: the partial unique index lets exactly one through', async () => {
    const userId = await db.createUser();
    const results = await Promise.allSettled([create(userId), create(userId), create(userId)]);
    const created = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.reason).toBeInstanceOf(ConflictException);
    const [{ n }] = await db.admin.query(
      `SELECT count(*)::int AS n FROM replay_sessions WHERE user_id = $1 AND status <> 'ENDED'`, [userId]);
    expect(n).toBe(1);
    await service.end(userId);
  });

  it('another user never sees or ends my session (404)', async () => {
    const owner = await db.createUser();
    const other = await db.createUser();
    await create(owner);
    await expect(service.getActive(other)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.end(other)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.getActive(owner)).status).toBe('PAUSED');
    await service.end(owner);
  });

  it('ending closes open positions at the clock minute close (SESSION_END) and cancels pending orders', async () => {
    const userId = await db.createUser();
    const session = await create(userId, { startTime: '2022-01-03T14:00Z', startingBalance: 5000 });
    const clock = new Date(session.clockTime);
    // Two positions filled earlier at real opens, and one order still pending
    const [fillTime] = (await db.admin.query(
      `SELECT time FROM historical_candles WHERE pair = 'EUR/USD' AND time < $1 ORDER BY time DESC LIMIT 1`, [clock]))
      .map((r: { time: Date }) => new Date(r.time));
    const fill = await minuteAt(db.admin, 'EUR/USD', fillTime);
    const insert = (side: 'BUY' | 'SELL', status: string, entry: number | null) => db.admin.query(
      `INSERT INTO replay_positions (session_id, side, lots, units, status, placed_at, margin_usd, entry_time, entry_points)
       VALUES ($1, $2, 0.10, 10000, $3, $4, 0, $5, $6) RETURNING id`,
      [session.id, side, status, fillTime, entry === null ? null : fillTime, entry]);
    await insert('BUY', 'OPEN', entryFill('BUY', fill));
    await insert('SELL', 'OPEN', entryFill('SELL', fill));
    await insert('BUY', 'PENDING', null);

    const ended = await service.end(userId);

    const atClock = await minuteAt(db.admin, 'EUR/USD', clock);
    const spec = { pair: 'EUR/USD', units: 10_000, priceDecimals: 5, pipPoints: 10 };
    const expectedNet = (['BUY', 'SELL'] as const).map((side) =>
      tradeMoney({ action: side, entryPoints: entryFill(side, fill), exitPoints: closeQuote(side, atClock) }, spec).netUsd);
    expect(ended.closed).toHaveLength(2);
    ended.closed.sort((a, b) => a.side.localeCompare(b.side)); // BUY, SELL
    expect(ended.closed.map((p) => [p.side, p.status, p.exitReason, p.exitTime, Number(p.realizedPnlUsd)])).toEqual([
      ['BUY', 'CLOSED', 'SESSION_END', clock.toISOString(), expectedNet[0]],
      ['SELL', 'CLOSED', 'SESSION_END', clock.toISOString(), expectedNet[1]],
    ]);
    // A long exits at the bid close, a short at the ask close
    expect(ended.closed[0].exitPrice).toBe((atClock.bid.close / 1e5).toFixed(5));
    expect(ended.closed[1].exitPrice).toBe((atClock.ask.close / 1e5).toFixed(5));
    expect(ended.cancelled.map((p) => p.status)).toEqual(['CANCELLED']);

    const expectedCents = 500_000 + Math.round(expectedNet[0] * 100) + Math.round(expectedNet[1] * 100);
    expect(ended.session).toMatchObject({ status: 'ENDED', balance: (expectedCents / 100).toFixed(2) });
    expect(ended.session.endedAt).not.toBeNull();
    // Stored balance = starting balance + realized P&L of the closed positions
    const [row] = await db.admin.query(
      `SELECT s.balance = s.starting_balance + coalesce(sum(p.realized_pnl_usd), 0) AS consistent
         FROM replay_sessions s LEFT JOIN replay_positions p ON p.session_id = s.id AND p.status = 'CLOSED'
        WHERE s.id = $1 GROUP BY s.id`, [session.id]);
    expect(row.consistent).toBe(true);

    // Ended: no active session, ending again is a 404, and a new one can start
    await expect(service.getActive(userId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.end(userId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await create(userId)).status).toBe('PAUSED');
    await service.end(userId);
  });
});
