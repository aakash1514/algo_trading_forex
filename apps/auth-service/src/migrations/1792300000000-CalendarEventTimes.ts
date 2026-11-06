import { MigrationInterface, QueryRunner } from 'typeorm';

// Step 6a follow-up. Every economic event now has its release moment as a UTC instant (scheduled_at) and
// says where that time comes from (time_source: 'official' when the source publishes it, 'expected' for
// the FOMC, whose statement time is the one its recent statements used). Date-only (all_day) events are
// gone: a migration can't fetch the official pages and must not invent a time, so every all-day row is
// deleted (counts logged per source) and the next calendar sync re-inserts, with times, every event still on
// the official pages. A row that is not all-day has no known time source, so the migration refuses it rather
// than guess. down() restores the all_day column (false everywhere) but not the deleted rows.
export class CalendarEventTimes1792300000000 implements MigrationInterface {
  name = 'CalendarEventTimes1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const timed = Number((await queryRunner.query(`SELECT count(*)::int AS n FROM economic_events WHERE NOT all_day`))[0].n);
    if (timed !== 0) throw new Error(`CalendarEventTimes: ${timed} timed row(s) without a known time source; refusing to guess`);

    const before: { source: string; n: number }[] = await queryRunner.query(
      `SELECT source, count(*)::int AS n FROM economic_events GROUP BY source ORDER BY source`);
    await queryRunner.query(`DELETE FROM economic_events WHERE all_day`);
    const after = Number((await queryRunner.query(`SELECT count(*)::int AS n FROM economic_events`))[0].n);
    if (after !== 0) throw new Error(`CalendarEventTimes: ${after} row(s) left after deleting the all-day events`);
    const deleted = before.map((r) => `${r.source} ${r.n}`).join(', ') || 'none';
    console.log(`CalendarEventTimes: deleted all-day events per source: ${deleted}; rows left ${after}`);

    await queryRunner.query(`ALTER TABLE economic_events DROP COLUMN all_day`);
    await queryRunner.query(
      `ALTER TABLE economic_events ADD COLUMN time_source VARCHAR(10) NOT NULL
         CONSTRAINT economic_events_time_source CHECK (time_source IN ('official', 'expected'))`,
    );
    // source is NOT NULL since RemovePreOfficialCalendarEvents, so the resync key needs no predicate
    await queryRunner.query(`DROP INDEX economic_events_source_event`);
    await queryRunner.query(`CREATE UNIQUE INDEX economic_events_source_event ON economic_events (source, scheduled_at, title)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX economic_events_source_event`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX economic_events_source_event ON economic_events (source, scheduled_at, title) WHERE source IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE economic_events DROP COLUMN time_source`);
    await queryRunner.query(`ALTER TABLE economic_events ADD COLUMN all_day BOOLEAN NOT NULL DEFAULT false`);
  }
}
