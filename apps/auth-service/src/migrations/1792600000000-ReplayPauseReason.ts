import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 6b-2: why a replay session is paused, for the Replay page.
//   USER            the user pressed pause
//   OTHER_TAB       another socket of the same user connected
//   DISCONNECT      the last socket left while playing
//   SERVER_RESTART  replay-service paused it on boot or on a clean stop
//   END_OF_DATA     the clock reached the pair's last imported minute
// Null while PLAYING and once ENDED (and for a session that was never played, or one
// paused after a failed step). The replay writer role already has UPDATE on the table.
export const REPLAY_PAUSE_REASONS = ['USER', 'OTHER_TAB', 'DISCONNECT', 'SERVER_RESTART', 'END_OF_DATA'];

export class ReplayPauseReason1792600000000 implements MigrationInterface {
  name = 'ReplayPauseReason1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE replay_sessions
        ADD COLUMN pause_reason varchar(14)
          CONSTRAINT replay_sessions_pause_reason_check
            CHECK (pause_reason IN (${REPLAY_PAUSE_REASONS.map((r) => `'${r}'`).join(', ')})),
        ADD CONSTRAINT replay_sessions_pause_reason_paused_check
          CHECK (pause_reason IS NULL OR status = 'PAUSED')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE replay_sessions DROP CONSTRAINT replay_sessions_pause_reason_paused_check`);
    await queryRunner.query(`ALTER TABLE replay_sessions DROP COLUMN pause_reason`);
  }
}
