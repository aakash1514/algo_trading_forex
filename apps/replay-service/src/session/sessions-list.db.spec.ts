// "My replays" against a real database (<DB_NAME>_test, the real Dukascopy EUR/USD and
// XAU/USD minutes of 2022-01-03, the replay login): list, rename and delete, each scoped
// to the user. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=sessions-list.db.spec.ts --skip-nx-cache
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ReplaySessionEntity } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb, XAUUSD_2022_01_03 } from '../../test/replay-test-db';
import { replayServices, ReplayServices } from '../../test/replay-services';
import { ReplayTradesService } from './trades.service';
import { PairContextService } from '../history/pair-context.service';
import { REPLAY_SESSION_CHILD_TABLES, SessionListItem } from './session-list';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

run('My replays: list, rename, delete (real DB, real minutes, replay login)', () => {
  jest.setTimeout(240_000);
  let db: ReplayTestDb;
  let svc: ReplayServices;
  let trades: ReplayTradesService;

  const create = (userId: string, over: Record<string, unknown> = {}) => svc.playback.createAndOpen(userId, () =>
    svc.sessions.create(userId, { instrument: 'EUR_USD', startTime: '2022-01-03T10:00Z', timeframe: '1m', ...over } as never));
  const allPages = async (userId: string) => {
    const items: SessionListItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.sessions.list(userId, cursor);
      items.push(...page.sessions);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    return { items, pages };
  };
  const count = async (sql: string, params: unknown[]): Promise<number> => (await db.admin.query(sql, params))[0].n;
  const exists = (id: string) => count(`SELECT count(*)::int AS n FROM replay_sessions WHERE id = $1`, [id]);
  const positionsOf = (id: string) => count(`SELECT count(*)::int AS n FROM replay_positions WHERE session_id = $1`, [id]);

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03, XAUUSD_2022_01_03]);
    svc = replayServices(db);
    trades = new ReplayTradesService(db.replay.getRepository(ReplaySessionEntity), db.replay, new PairContextService(db.replay));
  });

  afterAll(async () => {
    await svc?.playback.onModuleDestroy();
    await db?.close();
  });

  it('lists every session of the user, last opened first, 20 a page, with ties and microseconds at the boundary', async () => {
    const userId = await db.createUser();
    const stranger = await db.createUser();
    const theirs = await create(stranger);
    const ids: string[] = [];
    for (let i = 0; i < 23; i += 1) ids.push((await create(userId, { instrument: i % 2 ? 'XAU_USD' : 'EUR_USD' })).id);
    await svc.sessions.end(userId, ids[0]);
    // the 20th and 21st rows (the page boundary) and two more share one microsecond timestamp
    await db.admin.query(`UPDATE replay_sessions SET last_opened_at = '2026-11-20T10:00:00.123456Z' WHERE id = ANY($1)`,
      [ids.slice(0, 4)]);
    await db.admin.query(`UPDATE replay_sessions SET last_opened_at = timestamptz '2026-11-21T00:00:00Z' + n * interval '1 second'
      FROM (SELECT id AS sid, row_number() OVER (ORDER BY created_at, id) AS n FROM replay_sessions WHERE id = ANY($1)) o
      WHERE id = o.sid`, [ids.slice(4)]);

    const expected: string[] = (await db.admin.query(
      `SELECT id FROM replay_sessions WHERE user_id = $1 ORDER BY last_opened_at DESC, id DESC`, [userId])).map((r: { id: string }) => r.id);
    expect(expected).toHaveLength(23);
    const { items, pages } = await allPages(userId);
    expect(pages).toBe(2);
    expect(items.map((s) => s.id)).toEqual(expected);
    expect(items.map((s) => s.id)).not.toContain(theirs.id);
    expect((await svc.sessions.list(stranger)).sessions.map((s) => s.id)).toEqual([theirs.id]);

    // exactly one current: the latest opened that isn't ENDED
    expect(items.filter((s) => s.current).map((s) => s.id)).toEqual([expected[0]]);
    expect(items.find((s) => s.id === ids[0])).toMatchObject({ status: 'ENDED', current: false, endedAt: expect.any(String) });
    expect(items[0]).toMatchObject({
      instrument: expect.stringMatching(/^(EUR_USD|XAU_USD)$/), timeframe: '1m', clockTime: expect.any(String), netPnlUsd: '0.00',
      title: expect.stringMatching(/^(EUR\/USD|XAU\/USD) · 1m · 2022-01-03$/),
    });
    await expect(svc.sessions.list(userId, 'bm90LWpzb24')).rejects.toBeInstanceOf(BadRequestException);
    for (const id of ids.slice(1)) await svc.sessions.end(userId, id);
    await svc.sessions.end(stranger, theirs.id);
  });

  it('net P&L is the closed trades\' (balance - starting balance), equal to the statistics', async () => {
    const userId = await db.createUser();
    const s = await create(userId, { startingBalance: 5000 });
    await svc.orders.place(userId, s.id, { side: 'BUY', lots: 0.5 });
    for (let i = 0; i < 30; i += 1) await svc.playback.step(userId, s.id);
    await svc.sessions.end(userId, s.id);
    const [item] = (await svc.sessions.list(userId)).sessions;
    const [row] = await db.admin.query(`SELECT balance - starting_balance AS net FROM replay_sessions WHERE id = $1`, [s.id]);
    const stats = await trades.stats(userId, s.id);
    expect(stats.trades).toBe(1);
    expect(item.netPnlUsd).not.toBe('0.00');
    expect([item.netPnlUsd, stats.netPnlUsd]).toEqual([row.net, row.net]);
  });

  it('renames any of the user\'s sessions: trimmed, up to 60 characters, empty gives the auto name back', async () => {
    const userId = await db.createUser();
    const other = await db.createUser();
    const s = await create(userId, { title: '  FOMC week  ' });
    expect(s.title).toBe('FOMC week');
    expect((await svc.sessions.rename(userId, s.id, 'x'.repeat(60))).title).toBe('x'.repeat(60));
    await expect(svc.sessions.rename(userId, s.id, 'x'.repeat(61))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.sessions.rename(userId, s.id, `a${String.fromCodePoint(0x0a)}b`)).rejects.toBeInstanceOf(BadRequestException);
    expect((await db.admin.query(`SELECT title FROM replay_sessions WHERE id = $1`, [s.id]))[0].title).toBe('x'.repeat(60));
    expect((await svc.sessions.rename(userId, s.id, '')).title).toBe('EUR/USD · 1m · 2022-01-03');

    // another user's session: 404, unchanged
    await expect(svc.sessions.rename(other, s.id, 'mine now')).rejects.toBeInstanceOf(NotFoundException);
    expect((await db.admin.query(`SELECT title FROM replay_sessions WHERE id = $1`, [s.id]))[0].title).toBe('EUR/USD · 1m · 2022-01-03');

    await svc.sessions.end(userId, s.id);
    expect((await svc.sessions.rename(userId, s.id, 'Done')).title).toBe('Done'); // ENDED can be renamed
  });

  it('deletes only ENDED sessions, with all their positions; never a PAUSED or PLAYING one, never another user\'s', async () => {
    const userId = await db.createUser();
    const other = await db.createUser();
    const kept = await create(userId);
    await svc.orders.place(userId, kept.id, { side: 'SELL', lots: 0.1 });
    await svc.playback.step(userId, kept.id);
    const doomed = await create(userId, { instrument: 'XAU_USD' });
    await svc.orders.place(userId, doomed.id, { side: 'BUY', lots: 0.1 });
    await svc.orders.place(userId, doomed.id, { side: 'SELL', lots: 0.1 });
    await svc.playback.step(userId, doomed.id);

    // PAUSED (and the current one): refused, nothing removed
    const paused = await svc.sessions.remove(userId, doomed.id).catch((e) => e);
    expect(paused).toBeInstanceOf(ConflictException);
    expect(paused.message).toBe('End the session before deleting it');
    // PLAYING: refused
    await svc.playback.setSpeed(userId, doomed.id, 2000);
    await svc.playback.play(userId, doomed.id);
    await expect(svc.sessions.remove(userId, doomed.id)).rejects.toBeInstanceOf(ConflictException);
    await svc.playback.pause(userId, doomed.id);
    expect([await exists(doomed.id), await positionsOf(doomed.id)]).toEqual([1, 2]);

    await svc.sessions.end(userId, doomed.id);
    // another user: 404, nothing removed
    await expect(svc.sessions.remove(other, doomed.id)).rejects.toBeInstanceOf(NotFoundException);
    expect([await exists(doomed.id), await positionsOf(doomed.id)]).toEqual([1, 2]);

    await svc.sessions.remove(userId, doomed.id);
    expect([await exists(doomed.id), await positionsOf(doomed.id)]).toEqual([0, 0]);
    await expect(svc.sessions.remove(userId, doomed.id)).rejects.toBeInstanceOf(NotFoundException);
    // the user's other session and its position are untouched
    expect([await exists(kept.id), await positionsOf(kept.id)]).toEqual([1, 1]);
    await svc.sessions.end(userId, kept.id);
  });

  it('every table with rows of a session is deleted with it (the child list matches the foreign keys)', async () => {
    const rows: { table_name: string }[] = await db.admin.query(`
      SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'replay_sessions' ORDER BY 1`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.table_name)).toEqual([...REPLAY_SESSION_CHILD_TABLES].sort());
  });
});
