import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';

// CalendarEventTimes against the real schema (RUN_DB_TESTS): steps back to the date-only layout, stores
// all-day rows the way step 6a did (the first ECB entries of the recorded page, __fixtures__/), and checks
// the migration deletes them, logs the counts, and refuses a timed row whose time source it can't know.
const runDb = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

runDb('CalendarEventTimes migration (RUN_DB_TESTS)', () => {
  jest.setTimeout(180_000);
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb?.drop();
  });

  const lastMigration = async () =>
    (await testDb.dataSource.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0]?.name;

  const insertAllDay = async () => testDb.dataSource.query(
    `INSERT INTO economic_events (title, currency, impact, scheduled_at, all_day, source) VALUES
     ('Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 1)', 'EUR', 'LOW', '2026-10-28T00:00:00Z', true, 'ECB'),
     ('Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference', 'EUR', 'HIGH', '2026-10-29T00:00:00Z', true, 'ECB')`,
  );

  it('deletes the all-day rows, logs the counts per source, and replaces all_day with time_source', async () => {
    const ds = testDb.dataSource;
    // Newer migrations first: ReplayPauseReason (6b-2), ReplayTables (6b-1), then CalendarThirdPartyEvents and CalendarEventTimes
    expect(await lastMigration()).toBe('ReplayPauseReason1792600000000');
    await ds.undoLastMigration({ transaction: 'each' });
    expect(await lastMigration()).toBe('ReplayTables1792500000000');
    await ds.undoLastMigration({ transaction: 'each' });
    expect(await lastMigration()).toBe('CalendarThirdPartyEvents1792400000000');
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    expect(await lastMigration()).toBe('RemovePreOfficialCalendarEvents1792200000000');
    await insertAllDay();
    expect(Number((await ds.query('SELECT count(*)::int AS n FROM economic_events'))[0].n)).toBe(2);

    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await ds.runMigrations({ transaction: 'each' });
    expect(log).toHaveBeenCalledWith('CalendarEventTimes: deleted all-day events per source: ECB 2; rows left 0');
    log.mockRestore();

    expect(await lastMigration()).toBe('ReplayPauseReason1792600000000');
    expect(Number((await ds.query('SELECT count(*)::int AS n FROM economic_events'))[0].n)).toBe(0);
    const columns = (await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'economic_events' ORDER BY column_name`,
    )).map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain('time_source');
    expect(columns).not.toContain('all_day');
  });

  it('refuses a timed row whose time source is unknown, and leaves the table as it was', async () => {
    const ds = testDb.dataSource;
    await ds.undoLastMigration({ transaction: 'each' }); // ReplayPauseReason
    await ds.undoLastMigration({ transaction: 'each' }); // ReplayTables
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    await insertAllDay();
    await ds.query(`UPDATE economic_events SET all_day = false WHERE impact = 'HIGH'`);

    await expect(ds.runMigrations({ transaction: 'each' })).rejects.toThrow(/1 timed row\(s\) without a known time source/);
    expect(await lastMigration()).toBe('RemovePreOfficialCalendarEvents1792200000000');
    expect(Number((await ds.query('SELECT count(*)::int AS n FROM economic_events'))[0].n)).toBe(2);

    await ds.query('DELETE FROM economic_events');
    await ds.runMigrations({ transaction: 'each' });
    expect(await lastMigration()).toBe('ReplayPauseReason1792600000000');
  });
});
