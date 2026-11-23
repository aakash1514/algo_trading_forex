// Migration ReplaySessionsList against a real database (<DB_NAME>_test): it is reverted,
// rows written as the previous schema allowed, and applied again. Rows are inserted with
// raw SQL, as the previous release would have. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=sessions-migration.db.spec.ts --skip-nx-cache
import { createTestDatabase, TestDatabase } from '@forexedge/database/testing';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

run('migration ReplaySessionsList (real DB)', () => {
  jest.setTimeout(180_000);
  let db: TestDatabase;
  let userId: string;

  const insertSession = async (over: { status: string; updatedAt: string; startTime?: string; timeframe?: string }) => {
    const ended = over.status === 'ENDED' ? over.updatedAt : null;
    const [{ id }] = await db.dataSource.query(
      `INSERT INTO replay_sessions (user_id, pair, start_time, clock_time, status, timeframe, balance, updated_at, ended_at)
       VALUES ($1, 'EUR/USD', $2, $2, $3, $4, 10000, $5, $6) RETURNING id`,
      [userId, over.startTime ?? '2022-03-16T09:30Z', over.status, over.timeframe ?? '1m', over.updatedAt, ended]);
    return id as string;
  };
  const indexes = async (): Promise<string[]> =>
    (await db.dataSource.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'replay_sessions' ORDER BY 1`))
      .map((r: { indexname: string }) => r.indexname);

  beforeAll(async () => {
    db = await createTestDatabase();
    [{ id: userId }] = await db.dataSource.query(
      `INSERT INTO users (email, username, password_hash, first_name, last_name)
       VALUES ('replaymigration@example.com', 'replay_migration', 'not-a-real-hash', 'Replay', 'Test') RETURNING id`);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('is the last migration, and reverting it restores the one-active index', async () => {
    const [last] = await db.dataSource.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`);
    expect(last.name).toBe('ReplaySessionsList1792900000000');
    await db.dataSource.undoLastMigration({ transaction: 'each' });
    const names = await indexes();
    expect(names).toContain('replay_sessions_one_active_per_user');
    expect(names).not.toContain('replay_sessions_one_playing_per_user');
  });

  it('backfills last_opened_at from updated_at and the auto title, then allows several unended sessions', async () => {
    const ended = await insertSession({ status: 'ENDED', updatedAt: '2026-11-01T10:00:00Z', startTime: '2021-07-05T00:00Z', timeframe: '4h' });
    const paused = await insertSession({ status: 'PAUSED', updatedAt: '2026-11-20T08:15:30.123Z' });
    // the previous schema: a second unended session is refused
    await expect(insertSession({ status: 'PAUSED', updatedAt: '2026-11-21T00:00Z' })).rejects.toMatchObject({ code: '23505' });

    await db.dataSource.runMigrations({ transaction: 'each' });
    const rows: { id: string; title: string; last_opened_at: Date; updated_at: Date }[] = await db.dataSource.query(
      `SELECT id, title, last_opened_at, updated_at FROM replay_sessions WHERE user_id = $1 ORDER BY last_opened_at`, [userId]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([ended, paused]);
    for (const r of rows) expect(new Date(r.last_opened_at).getTime()).toBe(new Date(r.updated_at).getTime());
    expect(rows.map((r) => r.title)).toEqual(['EUR/USD · 4h · 2021-07-05', 'EUR/USD · 1m · 2022-03-16']);

    const names = await indexes();
    expect(names).toEqual(expect.arrayContaining(['replay_sessions_one_playing_per_user', 'replay_sessions_user_last_opened']));
    expect(names).not.toContain('replay_sessions_one_active_per_user');

    // several paused sessions, at most one playing, and a new row gets last_opened_at = now()
    const second = await insertSession({ status: 'PAUSED', updatedAt: '2026-11-22T00:00Z' });
    const [{ opened }] = await db.dataSource.query(`SELECT last_opened_at AS opened FROM replay_sessions WHERE id = $1`, [second]);
    expect(Math.abs(Date.now() - new Date(opened).getTime())).toBeLessThan(60_000);
    await db.dataSource.query(`UPDATE replay_sessions SET status = 'PLAYING' WHERE id = $1`, [paused]);
    await expect(db.dataSource.query(`UPDATE replay_sessions SET status = 'PLAYING' WHERE id = $1`, [second]))
      .rejects.toMatchObject({ code: '23505' });
    await db.dataSource.query(`UPDATE replay_sessions SET status = 'PAUSED' WHERE id = $1`, [paused]);
  });

  it('keeps titles to 1-60 characters (counted as characters, not bytes)', async () => {
    const [{ id }] = await db.dataSource.query(`SELECT id FROM replay_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
    const set = (title: string) => db.dataSource.query(`UPDATE replay_sessions SET title = $2 WHERE id = $1`, [id, title]);
    await expect(set('é'.repeat(60))).resolves.toBeDefined();   // 60 characters, 120 bytes
    await expect(set('x'.repeat(61))).rejects.toMatchObject({ code: '22001' });
    await expect(set('')).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses to revert while a user has two unended sessions', async () => {
    await expect(db.dataSource.undoLastMigration({ transaction: 'each' })).rejects.toThrow(/more than one unended replay session/);
    expect(await indexes()).toContain('replay_sessions_one_playing_per_user');
  });
});
