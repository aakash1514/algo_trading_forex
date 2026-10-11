import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 2.7c.
// - Held exits are persisted on the position: when a stop-loss/take-profit
//   triggers, its trigger price, reason and time are committed before the exit
//   is booked, and order-service retries booking from these columns. A restart
//   can no longer lose a stop that was hit. The exit always books at
//   pending_exit_price (the triggering tick's price), never the SL/TP level.
// - close_reason gains STOP_OUT (margin level below 50%, positions closed
//   biggest loser first). MARGIN_CALL stays valid for history but is never
//   written to open positions again: it used to be set on every open position
//   of an account in stop-out, which closed nothing.
export class PositionExitsAndStopOut1791637214599 implements MigrationInterface {
  name = 'PositionExitsAndStopOut1791637214599';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE positions
        ADD COLUMN pending_exit_price  NUMERIC(18,6) NULL,
        ADD COLUMN pending_exit_reason VARCHAR(20)   NULL
          CONSTRAINT positions_pending_exit_reason_check CHECK (pending_exit_reason IN ('STOP_LOSS','TAKE_PROFIT')),
        ADD COLUMN exit_triggered_at   TIMESTAMPTZ   NULL,
        ADD CONSTRAINT positions_pending_exit_complete CHECK (
          (pending_exit_price IS NULL) = (pending_exit_reason IS NULL)
          AND (pending_exit_price IS NULL OR exit_triggered_at IS NOT NULL))
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS positions_pending_exit ON positions (id) WHERE is_open AND pending_exit_price IS NOT NULL
    `);

    await queryRunner.query(`ALTER TABLE positions DROP CONSTRAINT positions_close_reason_check`);
    await queryRunner.query(`
      ALTER TABLE positions ADD CONSTRAINT positions_close_reason_check
        CHECK (close_reason IN ('MANUAL','STOP_LOSS','TAKE_PROFIT','MARGIN_CALL','STOP_OUT'))
    `);
    // close_reason describes how a position was closed; it has no meaning on an open one
    await queryRunner.query(`UPDATE positions SET close_reason = NULL WHERE is_open AND close_reason IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE positions SET close_reason = 'MARGIN_CALL' WHERE close_reason = 'STOP_OUT'`);
    await queryRunner.query(`ALTER TABLE positions DROP CONSTRAINT positions_close_reason_check`);
    await queryRunner.query(`
      ALTER TABLE positions ADD CONSTRAINT positions_close_reason_check
        CHECK (close_reason IN ('MANUAL','STOP_LOSS','TAKE_PROFIT','MARGIN_CALL'))
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS positions_pending_exit`);
    await queryRunner.query(`
      ALTER TABLE positions
        DROP CONSTRAINT positions_pending_exit_complete,
        DROP COLUMN exit_triggered_at,
        DROP COLUMN pending_exit_reason,
        DROP COLUMN pending_exit_price
    `);
  }
}
