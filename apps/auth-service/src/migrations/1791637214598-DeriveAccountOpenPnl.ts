import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 2.7c. account_summary no longer stores open (unrealized) P&L: it
// is the sum of the user's open positions' unrealized_pnl, computed on read.
// A stored copy had to be kept in step with every tick, fill and close, and
// lost updates between those paths made it drift (step 2.6/2.7b). Derived, it
// cannot drift. The partial indexes keep the per-account sums and the
// per-pair tick lookups cheap.
export class DeriveAccountOpenPnl1791637214598 implements MigrationInterface {
  name = 'DeriveAccountOpenPnl1791637214598';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS positions_open_by_user ON positions (user_id) WHERE is_open`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS positions_open_by_pair ON positions (pair) WHERE is_open`);
    await queryRunner.query(`ALTER TABLE account_summary DROP COLUMN unrealized_pnl`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE account_summary ADD COLUMN unrealized_pnl NUMERIC(12,2) NOT NULL DEFAULT 0`);
    // Restore the stored value from the positions it is derived from
    await queryRunner.query(`
      UPDATE account_summary a SET unrealized_pnl = COALESCE((
        SELECT SUM(p.unrealized_pnl) FROM positions p WHERE p.user_id = a.user_id AND p.is_open
      ), 0)
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS positions_open_by_pair`);
    await queryRunner.query(`DROP INDEX IF EXISTS positions_open_by_user`);
  }
}
