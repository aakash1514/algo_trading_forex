import { MigrationInterface, QueryRunner } from 'typeorm';

// Replay improvements: the replay chart marks economic calendar events, so the replay
// writer role may read economic_events (read only; domain-service stays its only
// writer). Additive: a release that doesn't read the calendar is unaffected.
export class ReplayCalendarRead1792700000000 implements MigrationInterface {
  name = 'ReplayCalendarRead1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT SELECT ON economic_events TO forexedge_replay_writer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON economic_events FROM forexedge_replay_writer`);
  }
}
