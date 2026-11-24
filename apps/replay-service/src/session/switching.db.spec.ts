// Several replay sessions per user against a real database (<DB_NAME>_test, the real
// Dukascopy EUR/USD and XAU/USD minutes of 2022-01-03, the replay login): every command
// names its session, only the current one changes, only one plays, ENDED is read-only.
// Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=switching.db.spec.ts --skip-nx-cache
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReplaySessionEntity } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb, XAUUSD_2022_01_03 } from '../../test/replay-test-db';
import { replayServices, ReplayServices } from '../../test/replay-services';
import { ReplayCommandError } from '../playback/playback.service';
import { NO_SUCH_SESSION, OTHER_SESSION_OPENED } from './current-session';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

const waitFor = async (check: () => Promise<boolean>, timeoutMs: number) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

run('replay session switching (real DB, real minutes, replay login)', () => {
  jest.setTimeout(180_000);
  let db: ReplayTestDb;
  let svc: ReplayServices;

  // Through the controller's path: createAndOpen pauses a playing session first
  const create = (userId: string, over: Record<string, unknown> = {}) => svc.playback.createAndOpen(userId, () =>
    svc.sessions.create(userId, { instrument: 'EUR_USD', startTime: '2022-01-03T09:00Z', timeframe: '1m', ...over } as never));
  const row = (id: string) => db.admin.getRepository(ReplaySessionEntity).findOneByOrFail({ id });
  const positionCount = async (sessionId: string): Promise<number> =>
    (await db.admin.query(`SELECT count(*)::int AS n FROM replay_positions WHERE session_id = $1`, [sessionId]))[0].n;
  const playingCount = async (userId: string): Promise<number> =>
    (await db.admin.query(`SELECT count(*)::int AS n FROM replay_sessions WHERE user_id = $1 AND status = 'PLAYING'`, [userId]))[0].n;
  const eventsFor = (userId: string, event: string) => svc.emitter.events.filter((e) => e.userId === userId && e.event === event);

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03, XAUUSD_2022_01_03]);
    svc = replayServices(db);
  });

  afterAll(async () => {
    await svc?.playback.onModuleDestroy();
    await db?.close();
  });

  it('opening B while A plays pauses A first (its timer stops), and B comes back PAUSED as the current one', async () => {
    const userId = await db.createUser();
    const a = await create(userId);
    const b = await create(userId, { instrument: 'XAU_USD' });
    await svc.playback.open(userId, a.id);
    await svc.playback.setSpeed(userId, a.id, 500);
    await svc.playback.play(userId, a.id);
    expect(await waitFor(async () => (await row(a.id)).clockTime.toISOString() !== a.clockTime, 5_000)).toBe(true);

    const state = await svc.playback.open(userId, b.id);
    expect(state.session).toMatchObject({ id: b.id, status: 'PAUSED' });
    expect(await row(a.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'USER' });
    expect((await svc.sessions.getActive(userId)).id).toBe(b.id);
    expect(eventsFor(userId, 'switched').at(-1)?.payload).toEqual({ pausedSessionIds: [a.id], openedSessionId: b.id });

    // A's timer is gone: its clock no longer moves and no more bars are sent for it
    const clockAfter = (await row(a.id)).clockTime.toISOString();
    const barsAfter = eventsFor(userId, 'bar').length;
    await sleep(1_500);
    expect((await row(a.id)).clockTime.toISOString()).toBe(clockAfter);
    expect(eventsFor(userId, 'bar')).toHaveLength(barsAfter);
    expect(await playingCount(userId)).toBe(0);

    await svc.sessions.end(userId, a.id);
    await svc.sessions.end(userId, b.id);
  });

  it('a stale tab (still on A after B was opened) can never act on B, and can\'t restart A', async () => {
    const userId = await db.createUser();
    const a = await create(userId);
    const b = await create(userId, { instrument: 'XAU_USD' }); // B is now current; A was left
    const placedOnB = await svc.orders.place(userId, b.id, { side: 'BUY', lots: 0.01 });
    const before = { a: await positionCount(a.id), b: await positionCount(b.id) };

    const order = await svc.orders.place(userId, a.id, { side: 'BUY', lots: 0.1 }).catch((e) => e);
    expect(order).toBeInstanceOf(ConflictException);
    expect(order.message).toBe(OTHER_SESSION_OPENED);
    await expect(svc.orders.close(userId, a.id, placedOnB.position.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.orders.cancel(userId, a.id, placedOnB.position.id)).rejects.toBeInstanceOf(ConflictException);
    for (const command of [
      () => svc.playback.play(userId, a.id), () => svc.playback.step(userId, a.id),
      () => svc.playback.setSpeed(userId, a.id, 500), () => svc.playback.setTimeframe(userId, a.id, '5m'),
    ]) {
      await expect(command()).rejects.toThrow(new ReplayCommandError(OTHER_SESSION_OPENED));
    }
    // nothing landed anywhere: B's order is still its only position, still PENDING
    expect({ a: await positionCount(a.id), b: await positionCount(b.id) }).toEqual(before);
    expect(before).toEqual({ a: 0, b: 1 });
    expect((await row(b.id)).status).toBe('PAUSED');
    expect(await playingCount(userId)).toBe(0);
    // pausing its own session is harmless and allowed
    expect((await svc.playback.pause(userId, a.id)).id).toBe(a.id);
    // opening A again makes it current: the same order now lands in A
    await svc.playback.open(userId, a.id);
    expect((await svc.orders.place(userId, a.id, { side: 'BUY', lots: 0.1 })).position.sessionId).toBe(a.id);
    expect(await positionCount(b.id)).toBe(1);

    await svc.sessions.end(userId, a.id);
    await svc.sessions.end(userId, b.id);
  });

  it('an ENDED session refuses every order and command, also while another session is open', async () => {
    const userId = await db.createUser();
    const ended = await create(userId);
    const placed = await svc.orders.place(userId, ended.id, { side: 'SELL', lots: 0.1 });
    await svc.sessions.end(userId, ended.id);
    const other = await create(userId, { instrument: 'XAU_USD' });

    for (const attempt of [
      () => svc.orders.place(userId, ended.id, { side: 'BUY', lots: 0.1 }),
      () => svc.orders.close(userId, ended.id, placed.position.id),
      () => svc.orders.cancel(userId, ended.id, placed.position.id),
      () => svc.sessions.end(userId, ended.id),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
    }
    for (const command of [
      () => svc.playback.play(userId, ended.id), () => svc.playback.pause(userId, ended.id),
      () => svc.playback.step(userId, ended.id), () => svc.playback.setSpeed(userId, ended.id, 500),
      () => svc.playback.setTimeframe(userId, ended.id, '5m'),
    ]) {
      await expect(command()).rejects.toThrow(new ReplayCommandError(NO_SUCH_SESSION));
    }
    expect(await row(ended.id)).toMatchObject({ status: 'ENDED' });

    // opening it is read-only: its state up to the end, the current session stays the other one
    const view = await svc.playback.open(userId, ended.id);
    expect(view.session).toMatchObject({ id: ended.id, status: 'ENDED', clockTime: ended.clockTime });
    expect(view.positions.map((p) => p.status)).toEqual(['CANCELLED']);
    expect((await svc.sessions.getActive(userId)).id).toBe(other.id);
    expect(eventsFor(userId, 'switched').at(-1)?.payload).toMatchObject({ openedSessionId: other.id });
    await svc.sessions.end(userId, other.id);
  });

  it('create while A plays pauses A first; two creates at once leave nothing playing, and only the current one can play', async () => {
    const userId = await db.createUser();
    const a = await create(userId);
    await svc.playback.setSpeed(userId, a.id, 2000);
    await svc.playback.play(userId, a.id);
    expect(await playingCount(userId)).toBe(1);

    const [b, c] = await Promise.all([create(userId, { instrument: 'XAU_USD' }), create(userId)]);
    expect(await row(a.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'USER' });
    expect(await playingCount(userId)).toBe(0);
    const current = (await svc.sessions.getActive(userId)).id;
    expect([b.id, c.id]).toContain(current);

    // both new sessions try to play at once: only the current one may
    const results = await Promise.allSettled([svc.playback.play(userId, b.id), svc.playback.play(userId, c.id)]);
    const played = results.filter((r) => r.status === 'fulfilled');
    expect(played).toHaveLength(1);
    expect((played[0] as PromiseFulfilledResult<{ id: string }>).value.id).toBe(current);
    expect(await playingCount(userId)).toBe(1);

    await svc.playback.pause(userId, current);
    for (const s of [a, b, c]) await svc.sessions.end(userId, s.id);
  });

  it('another user\'s session: open, end and commands are 404 / not found, and nothing changes', async () => {
    const owner = await db.createUser();
    const other = await db.createUser();
    const mine = await create(owner);
    const before = await row(mine.id);
    await expect(svc.playback.open(other, mine.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.sessions.end(other, mine.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.orders.place(other, mine.id, { side: 'BUY', lots: 0.1 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.playback.play(other, mine.id)).rejects.toThrow(new ReplayCommandError(NO_SUCH_SESSION));
    expect(await row(mine.id)).toMatchObject({ status: 'PAUSED', lastOpenedAt: before.lastOpenedAt });
    await svc.sessions.end(owner, mine.id);
  });

  it('a connecting socket gets the latest opened session; the last socket leaving pauses whatever plays', async () => {
    const userId = await db.createUser();
    const a = await create(userId);
    const b = await create(userId, { instrument: 'XAU_USD' });
    expect((await svc.playback.connected(userId, false))?.session.id).toBe(b.id);
    await svc.playback.open(userId, a.id);
    expect((await svc.playback.connected(userId, false))?.session.id).toBe(a.id);
    await svc.playback.play(userId, a.id);
    await svc.playback.lastSocketLeft(userId);
    expect(await row(a.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'DISCONNECT' });
    for (const s of [a, b]) await svc.sessions.end(userId, s.id);
  });

  it('a restart pauses every playing session (one per user) and leaves the paused ones as they were; nothing conflicts', async () => {
    const userId = await db.createUser();
    const other = await db.createUser();
    const a = await create(userId);
    const b = await create(userId, { instrument: 'XAU_USD' });
    const c = await create(other);
    await svc.playback.pause(userId, b.id);
    await db.admin.query(`UPDATE replay_sessions SET pause_reason = 'DISCONNECT' WHERE id = $1`, [b.id]);
    await svc.playback.open(userId, a.id);
    await svc.playback.setSpeed(userId, a.id, 2000);
    await svc.playback.play(userId, a.id);
    await svc.playback.setSpeed(other, c.id, 2000);
    await svc.playback.play(other, c.id);
    expect([await playingCount(userId), await playingCount(other)]).toEqual([1, 1]);

    const booted = replayServices(db).playback; // a new process: its boot runs pauseAllPlaying
    await booted.onModuleInit();
    expect(await row(a.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'SERVER_RESTART' });
    expect(await row(c.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'SERVER_RESTART' });
    expect(await row(b.id)).toMatchObject({ status: 'PAUSED', pauseReason: 'DISCONNECT' });
    expect([await playingCount(userId), await playingCount(other)]).toEqual([0, 0]);
    // nothing resumes, and the index doesn't block playing the current session again
    const clock = (await row(a.id)).clockTime.toISOString();
    await sleep(2_500);
    expect((await row(a.id)).clockTime.toISOString()).toBe(clock);
    expect((await booted.play(userId, a.id)).status).toBe('PLAYING');
    await booted.onModuleDestroy();
    for (const [u, s] of [[userId, a], [userId, b], [other, c]] as const) await svc.sessions.end(u, s.id);
  });

  it('every account and position event names its session', async () => {
    const userId = await db.createUser();
    const a = await create(userId);
    const from = svc.emitter.events.length;
    await svc.orders.place(userId, a.id, { side: 'BUY', lots: 0.1 });
    await svc.playback.step(userId, a.id);
    const sent = svc.emitter.events.slice(from).filter((e) => e.userId === userId);
    const accounts = sent.filter((e) => e.event === 'account').map((e) => (e.payload as { sessionId: string }).sessionId);
    const positions = sent.filter((e) => e.event === 'positions').flatMap((e) => (e.payload as { sessionId: string }[]).map((p) => p.sessionId));
    expect(accounts.length).toBeGreaterThan(0);
    expect(positions.length).toBeGreaterThan(0);
    expect(new Set([...accounts, ...positions])).toEqual(new Set([a.id]));
    await svc.sessions.end(userId, a.id);
  });
});
