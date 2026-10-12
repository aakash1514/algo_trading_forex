import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 6a. The economic calendar comes from official central-bank calendars (domain-service
// economic-calendar/official-sources.ts): each event records its source (FOMC, ECB), and whether it is
// all-day, because those calendars publish dates without times (stored at 00:00 UTC of the date; no
// time is invented). Rows from before step 6a have no source. The unique index makes a source's
// resync idempotent.
export class EconomicEventSource1792100000000 implements MigrationInterface {
  name = 'EconomicEventSource1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE economic_events ADD COLUMN source VARCHAR(20)`);
    await queryRunner.query(`ALTER TABLE economic_events ADD COLUMN all_day BOOLEAN NOT NULL DEFAULT false`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX economic_events_source_event ON economic_events (source, scheduled_at, title) WHERE source IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS economic_events_source_event`);
    await queryRunner.query(`ALTER TABLE economic_events DROP COLUMN all_day`);
    await queryRunner.query(`ALTER TABLE economic_events DROP COLUMN source`);
  }
}
