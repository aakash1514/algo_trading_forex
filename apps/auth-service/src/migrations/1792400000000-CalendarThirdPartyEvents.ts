import { MigrationInterface, QueryRunner } from 'typeorm';

// Step 6a follow-up. Events from a third-party calendar export (time_source 'third_party': the third party
// publishes the time, with its UTC offset) next to the official ('official') and expected ('expected') ones.
// A third-party export lists the same release for several currencies at the same moment (e.g. the CAD and USD
// "Unemployment Rate" at 08:30 New York), so the resync key gains the currency; without it one of them would
// be dropped. down() refuses while third-party rows exist (the old constraint would reject them; they are
// not deleted silently) or while two rows differ only by currency.
export class CalendarThirdPartyEvents1792400000000 implements MigrationInterface {
  name = 'CalendarThirdPartyEvents1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE economic_events DROP CONSTRAINT economic_events_time_source`);
    await queryRunner.query(`ALTER TABLE economic_events ALTER COLUMN time_source TYPE VARCHAR(11)`);
    await queryRunner.query(
      `ALTER TABLE economic_events ADD CONSTRAINT economic_events_time_source
         CHECK (time_source IN ('official', 'expected', 'third_party'))`,
    );
    await queryRunner.query(`DROP INDEX economic_events_source_event`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX economic_events_source_event ON economic_events (source, scheduled_at, currency, title)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const n = Number((await queryRunner.query(
      `SELECT count(*)::int AS n FROM economic_events WHERE time_source = 'third_party'`))[0].n);
    if (n !== 0) throw new Error(`CalendarThirdPartyEvents: ${n} third-party row(s) exist; delete them before reverting`);
    await queryRunner.query(`DROP INDEX economic_events_source_event`);
    await queryRunner.query(`CREATE UNIQUE INDEX economic_events_source_event ON economic_events (source, scheduled_at, title)`);
    await queryRunner.query(`ALTER TABLE economic_events DROP CONSTRAINT economic_events_time_source`);
    await queryRunner.query(`ALTER TABLE economic_events ALTER COLUMN time_source TYPE VARCHAR(10)`);
    await queryRunner.query(
      `ALTER TABLE economic_events ADD CONSTRAINT economic_events_time_source CHECK (time_source IN ('official', 'expected'))`,
    );
  }
}
