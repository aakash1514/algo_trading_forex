import { MigrationInterface, QueryRunner } from 'typeorm';

// Replay "My replays" (plan docs/plans/replay-sessions.md): a user keeps several replay
// sessions, of which at most one plays.
// - title: the user's name for the session, 1-60 characters (the server trims it and refuses
//   control and format characters). A session created without one stores the auto name
//   'EUR/USD · 1m · 2022-03-16' (pair · timeframe · start date UTC); existing rows get it here.
// - last_opened_at: when the user last opened the session; the list's order and the user's
//   current session (the latest opened one that isn't ENDED). Backfilled from updated_at.
// - one PLAYING session per user replaces one non-ENDED session per user. The new index is
//   created before the old one is dropped. The previous release still works on this schema:
//   its create refuses (409) by a query whenever an unended session exists, and the new index
//   refuses a second PLAYING row.
// - forexedge_replay_writer may DELETE from the two replay tables (a user deletes an ENDED
//   session with its positions, in one transaction). Every other table stays as it was.
export const REPLAY_AUTO_TITLE_SQL =
  `pair || ' · ' || timeframe || ' · ' || to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

export class ReplaySessionsList1792900000000 implements MigrationInterface {
  name = 'ReplaySessionsList1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE replay_sessions
        ADD COLUMN title varchar(60) NULL
          CONSTRAINT replay_sessions_title_check CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 60),
        ADD COLUMN last_opened_at timestamptz NULL
    `);
    await queryRunner.query(`UPDATE replay_sessions SET last_opened_at = updated_at`);
    await queryRunner.query(`UPDATE replay_sessions SET title = ${REPLAY_AUTO_TITLE_SQL} WHERE title IS NULL`);
    await queryRunner.query(`
      ALTER TABLE replay_sessions ALTER COLUMN last_opened_at SET DEFAULT now(), ALTER COLUMN last_opened_at SET NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX replay_sessions_user_last_opened ON replay_sessions (user_id, last_opened_at DESC, id DESC)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX replay_sessions_one_playing_per_user ON replay_sessions (user_id) WHERE status = 'PLAYING'
    `);
    await queryRunner.query(`DROP INDEX replay_sessions_one_active_per_user`);
    await queryRunner.query(`GRANT DELETE ON replay_sessions, replay_positions TO forexedge_replay_writer`);
  }

  // The old index holds only while no user has two unended sessions: refuse clearly otherwise
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: { n: number }[] = await queryRunner.query(`
      SELECT count(*)::int AS n FROM (
        SELECT user_id FROM replay_sessions WHERE status <> 'ENDED' GROUP BY user_id HAVING count(*) > 1
      ) t
    `);
    if (rows[0].n > 0) {
      throw new Error(`${rows[0].n} user(s) have more than one unended replay session: end or delete them before reverting`);
    }
    await queryRunner.query(`REVOKE DELETE ON replay_sessions, replay_positions FROM forexedge_replay_writer`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX replay_sessions_one_active_per_user ON replay_sessions (user_id) WHERE status <> 'ENDED'
    `);
    await queryRunner.query(`DROP INDEX replay_sessions_one_playing_per_user`);
    await queryRunner.query(`DROP INDEX replay_sessions_user_last_opened`);
    await queryRunner.query(`ALTER TABLE replay_sessions DROP COLUMN last_opened_at, DROP COLUMN title`);
  }
}
