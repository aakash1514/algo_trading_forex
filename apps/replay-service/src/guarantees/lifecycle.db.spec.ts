// Replay lifecycle through the real app (AppModule over HTTP and the /replay socket),
// against <DB_NAME>_test with the real EUR/USD minutes of 2022-01-03, as a login with
// forexedge_replay's grants. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=lifecycle.db.spec.ts --skip-nx-cache
import { JwtService } from '@nestjs/jwt';
import { ReplaySessionEntity } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb } from '../../test/replay-test-db';
import { accessToken, connectClient, http, ReplayApp, startReplayApp } from '../../test/replay-app';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

run('replay lifecycle (real app, real DB, real minutes)', () => {
  jest.setTimeout(180_000);
  let db: ReplayTestDb;
  let app: ReplayApp;

  const user = async () => {
    const userId = await db.createUser();
    return { userId, token: accessToken(userId) };
  };
  const create = (token: string, over: Record<string, unknown> = {}) =>
    http<{ id: string; clockTime: string; activeSessionId?: string }>(app.url, token, 'POST', '/sessions',
      { instrument: 'EUR_USD', startTime: '2022-01-03T09:00Z', timeframe: '1m', ...over });
  const stored = (id: string) => db.admin.getRepository(ReplaySessionEntity).findOneByOrFail({ id });
  const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5_000) => {
    for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(50)) if (await check()) return true;
    return false;
  };

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03]);
    app = await startReplayApp(db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it('one active session per user: 409 with the active session id', async () => {
    const { token } = await user();
    const first = await create(token);
    expect(first.status).toBe(201);
    const second = await create(token, { instrument: 'EUR_USD', startTime: '2022-01-03T12:00Z' });
    expect(second.status).toBe(409);
    expect(second.body.activeSessionId).toBe(first.body.id);
    expect((await http(app.url, token, 'POST', '/sessions/active/end')).status).toBe(200);
    expect((await create(token)).status).toBe(201);
    await http(app.url, token, 'POST', '/sessions/active/end');
  });

  it('a socket without a valid token is refused', async () => {
    const wrongSecret = new JwtService().sign({ sub: '00000000-0000-4000-8000-000000000000' }, { secret: 'not-the-secret' });
    for (const token of ['', 'not-a-token', wrongSecret]) {
      await expect(connectClient(app.url, token)).rejects.toThrow();
    }
  });

  it('the last socket leaving pauses and saves; a reconnect is always PAUSED and never plays', async () => {
    const { token } = await user();
    const { body: session } = await create(token);
    const a = await connectClient(app.url, token);
    expect((await a.command('setSpeed', { speedMs: 500 })).ok).toBe(true);
    expect((await a.command('play')).ok).toBe(true);
    await a.next('bar');
    expect((await stored(session.id)).status).toBe('PLAYING');
    await a.close();
    expect(await waitFor(async () => (await stored(session.id)).status === 'PAUSED')).toBe(true);
    expect((await stored(session.id)).pauseReason).toBe('DISCONNECT');
    const clock = (await stored(session.id)).clockTime.getTime();
    await sleep(1_500);
    expect((await stored(session.id)).clockTime.getTime()).toBe(clock);

    const b = await connectClient(app.url, token);
    // a lone reconnect keeps DISCONNECT
    expect(b.state).toMatchObject({
      session: { id: session.id, status: 'PAUSED', pauseReason: 'DISCONNECT', clockTime: new Date(clock).toISOString() },
    });
    await sleep(1_500);
    expect(b.events.filter((e) => e.event === 'bar')).toEqual([]);
    expect((await stored(session.id)).clockTime.getTime()).toBe(clock);
    await b.close();
    await http(app.url, token, 'POST', '/sessions/active/end');
  });

  it('a second tab: connecting pauses, and only the last socket leaving pauses a replay played again', async () => {
    const { token } = await user();
    const { body: session } = await create(token);
    const a = await connectClient(app.url, token);
    await a.command('setSpeed', { speedMs: 500 });
    await a.command('play');
    const toldA = a.next('status');
    const b = await connectClient(app.url, token);
    expect(b.state).toMatchObject({ session: { status: 'PAUSED', pauseReason: 'OTHER_TAB' } });
    expect(await toldA).toMatchObject({ status: 'PAUSED', pauseReason: 'OTHER_TAB' });
    expect(await stored(session.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'OTHER_TAB' });
    expect(await a.command('play')).toMatchObject({ ok: true, result: { status: 'PLAYING', pauseReason: null } });
    expect((await stored(session.id)).pauseReason).toBeNull();
    await b.close();
    await sleep(300);
    expect((await stored(session.id)).status).toBe('PLAYING');
    await a.close();
    expect(await waitFor(async () => (await stored(session.id)).status === 'PAUSED')).toBe(true);
    expect((await stored(session.id)).pauseReason).toBe('DISCONNECT');
    await http(app.url, token, 'POST', '/sessions/active/end');
  });

  it('a user only receives their own session', async () => {
    const one = await user();
    const two = await user();
    await create(one.token);
    await create(two.token);
    const a = await connectClient(app.url, one.token);
    const b = await connectClient(app.url, two.token);
    expect((await a.command('step')).ok).toBe(true);
    await sleep(300);
    expect(a.events.filter((e) => e.event === 'bar')).toHaveLength(1);
    expect(b.events.filter((e) => e.event !== 'state')).toEqual([]);
    expect((b.state as { session: { id: string } }).session.id).not.toBe((a.state as { session: { id: string } }).session.id);
    await a.close();
    await b.close();
    await http(app.url, one.token, 'POST', '/sessions/active/end');
    await http(app.url, two.token, 'POST', '/sessions/active/end');
  });

  it('accepts only 500, 1000 and 2000 ms per bar over the socket', async () => {
    const { token } = await user();
    const { body: session } = await create(token);
    const c = await connectClient(app.url, token);
    for (const speedMs of [750, 250, 3000, 0, -500, 0.5, 1, 2, '1000', null, undefined, 1000.5]) {
      const ack = await c.command('setSpeed', { speedMs });
      expect(ack).toEqual({ ok: false, error: 'speedMs must be 500, 1000 or 2000 (milliseconds per bar)' });
    }
    expect((await stored(session.id)).speedMs).toBe(1000);
    for (const speedMs of [500, 2000, 1000]) {
      expect(await c.command('setSpeed', { speedMs })).toMatchObject({ ok: true, result: { speedMs } });
    }
    await c.close();
    await http(app.url, token, 'POST', '/sessions/active/end');
  });

  it('a second tab on a session paused by the user: OTHER_TAB replaces USER and the first tab is told', async () => {
    const { token } = await user();
    const { body: session } = await create(token);
    const a = await connectClient(app.url, token);
    expect(a.state).toMatchObject({ session: { status: 'PAUSED', pauseReason: null } }); // never played
    await a.command('play');
    expect(await a.command('pause')).toMatchObject({ ok: true, result: { status: 'PAUSED', pauseReason: 'USER' } });
    expect((await stored(session.id)).pauseReason).toBe('USER');
    const toldA = a.next('status');
    const b = await connectClient(app.url, token);
    expect(b.state).toMatchObject({ session: { pauseReason: 'OTHER_TAB' } });
    expect(await toldA).toMatchObject({ status: 'PAUSED', pauseReason: 'OTHER_TAB' });
    // leaving a paused session keeps its reason
    await b.close();
    await a.close();
    await sleep(300);
    expect(await stored(session.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'OTHER_TAB' });
    await http(app.url, token, 'POST', '/sessions/active/end');
    expect(await stored(session.id)).toMatchObject({ status: 'ENDED', pauseReason: null });
  });

  it('a boot pauses every PLAYING session and never resumes it', async () => {
    const { userId, token } = await user();
    const { body: session } = await create(token);
    await db.admin.query(`UPDATE replay_sessions SET status = 'PLAYING' WHERE user_id = $1`, [userId]);
    const second = await startReplayApp(db);
    try {
      expect(await stored(session.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'SERVER_RESTART' });
      const clock = (await stored(session.id)).clockTime.getTime();
      await sleep(1_500);
      expect((await stored(session.id)).clockTime.getTime()).toBe(clock);
    } finally {
      await second.close();
    }
    await http(app.url, token, 'POST', '/sessions/active/end');
  });

  it('cancel: a PENDING order only, its margin released; 409 once filled', async () => {
    const { token } = await user();
    await create(token);
    const c = await connectClient(app.url, token);
    const placed = await http<{ position: { id: string }; account: { marginUsed: string } }>(
      app.url, token, 'POST', '/sessions/active/orders', { side: 'BUY', lots: 0.1 });
    expect(placed.status).toBe(201);
    expect(placed.body.account.marginUsed).not.toBe('0.00');
    const cancelled = await http<{ position: { status: string }; account: { marginUsed: string } }>(
      app.url, token, 'POST', `/sessions/active/orders/${placed.body.position.id}/cancel`);
    expect([cancelled.status, cancelled.body.position.status, cancelled.body.account.marginUsed]).toEqual([200, 'CANCELLED', '0.00']);
    expect((await http(app.url, token, 'POST', `/sessions/active/orders/${placed.body.position.id}/cancel`)).status).toBe(409);
    const filled = await http<{ position: { id: string } }>(app.url, token, 'POST', '/sessions/active/orders', { side: 'SELL', lots: 0.1 });
    await c.command('step');
    const late = await http<{ message: string }>(app.url, token, 'POST', `/sessions/active/orders/${filled.body.position.id}/cancel`);
    expect([late.status, late.body.message]).toEqual([409, 'The order has already filled']);
    await c.close();
    await http(app.url, token, 'POST', '/sessions/active/end');
  });

  // A real minute where a long's SL and TP are both inside one minute: EUR/USD
  // 2022-01-03 13:43 UTC. Placed at 13:41 (bid close 1.13495), filled at 13:42's ask open
  // (13:42's bid stays inside 1.13479-1.13498, touching neither level), then 13:43 opens
  // at 1.13480 and trades down to 1.13478 (SL) and up to 1.13539 (TP).
  it('SL first when SL and TP are both hit in one real minute (EUR/USD 2022-01-03 13:43)', async () => {
    const [m] = await db.admin.query(`
      WITH m AS (
        SELECT time, bid_close,
               lead(time) OVER w AS t1, lead(bid_open) OVER w AS o1, lead(bid_high) OVER w AS h1, lead(bid_low) OVER w AS l1,
               lead(time, 2) OVER w AS t2, lead(bid_open, 2) OVER w AS o2, lead(bid_high, 2) OVER w AS h2, lead(bid_low, 2) OVER w AS l2
          FROM historical_candles WHERE pair = 'EUR/USD' WINDOW w AS (ORDER BY time))
      SELECT time, t1, t2, bid_close, o1, h1, l1, o2, h2, l2 FROM m WHERE time = '2022-01-03T13:41Z'`);
    // Both levels inside 13:43, neither touched by the fill minute, 13:43 opening between them
    expect([new Date(m.t1).toISOString(), new Date(m.t2).toISOString()]).toEqual(['2022-01-03T13:42:00.000Z', '2022-01-03T13:43:00.000Z']);
    const [sl, tp] = [m.l2 as number, m.h2 as number];
    expect([sl, tp]).toEqual([113478, 113539]);
    expect(sl < m.bid_close && m.bid_close < tp).toBe(true);
    expect(m.l1 > sl && m.h1 < tp && m.o1 > sl && m.o1 < tp && m.o2 > sl && m.o2 < tp).toBe(true);

    const { token } = await user();
    await create(token, { startTime: '2022-01-03T13:41Z' });
    const c = await connectClient(app.url, token);
    const placed = await http<{ position: { id: string } }>(app.url, token, 'POST', '/sessions/active/orders',
      { side: 'BUY', lots: 0.1, stopLoss: sl / 1e5, takeProfit: tp / 1e5 });
    expect(placed.status).toBe(201);
    expect((await c.command('step')).ok).toBe(true); // 13:42: fills, no exit
    expect((await c.command('step')).ok).toBe(true); // 13:43: both levels inside the minute
    const [p] = await db.admin.query('SELECT * FROM replay_positions WHERE id = $1', [placed.body.position.id]);
    expect([p.status, new Date(p.entry_time).toISOString(), p.entry_points]).toEqual(['CLOSED', '2022-01-03T13:42:00.000Z', p.entry_points]);
    expect([p.exit_reason, new Date(p.exit_time).toISOString(), p.exit_points]).toEqual(['SL', '2022-01-03T13:43:00.000Z', sl]);
    await c.close();
    await http(app.url, token, 'POST', '/sessions/active/end');
  });
});
