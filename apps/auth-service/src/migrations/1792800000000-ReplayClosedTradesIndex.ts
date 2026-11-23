import { MigrationInterface, QueryRunner } from 'typeorm';

// Replay improvements: the paged closed-trade history reads a session's CLOSED positions
// newest first, keyset on (exit_time DESC, id DESC); this partial index is exactly that
// order. Additive (nothing dropped or renamed), so the previous release is unaffected.
export class ReplayClosedTradesIndex1792800000000 implements MigrationInterface {
  name = 'ReplayClosedTradesIndex1792800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS replay_positions_closed_keyset
        ON replay_positions (session_id, exit_time DESC, id DESC) WHERE status = 'CLOSED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS replay_positions_closed_keyset`);
  }
}
