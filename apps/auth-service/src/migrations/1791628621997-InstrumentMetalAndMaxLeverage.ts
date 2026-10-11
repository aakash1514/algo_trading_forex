import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 2.6 (XAU/USD), schema only:
// - a METAL instrument type
// - instruments.max_leverage, the per-instrument leverage cap
//   (effective leverage = min(account leverage, max_leverage); null = no cap)
//
// The XAU/USD row itself is inserted by the instruments seed, where every
// instrument row lives. It can't go here anyway: Postgres doesn't allow a new
// enum value to be used in the transaction that adds it, and migrations run in
// one transaction.
export class InstrumentMetalAndMaxLeverage1791628621997 implements MigrationInterface {
  name = 'InstrumentMetalAndMaxLeverage1791628621997';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE instruments_type_enum ADD VALUE IF NOT EXISTS 'METAL'`);
    await queryRunner.query(`
      ALTER TABLE instruments
        ADD COLUMN max_leverage SMALLINT NULL
        CONSTRAINT instruments_max_leverage_positive CHECK (max_leverage > 0)
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN instruments.max_leverage IS
        'Leverage cap; effective leverage = min(account leverage, max_leverage). NULL = no cap.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN instruments.avg_spread IS
        'Typical spread as a price difference (ask - bid), not pips: EUR/USD 0.0001, XAU/USD 0.368.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`COMMENT ON COLUMN instruments.avg_spread IS NULL`);
    await queryRunner.query(`ALTER TABLE instruments DROP COLUMN max_leverage`);
    // The METAL enum value stays: Postgres has no ALTER TYPE ... DROP VALUE.
    // Removing it would mean recreating instruments_type_enum and rewriting the
    // column, which isn't worth it for an unused label. Delete any METAL rows
    // (XAU/USD) by hand first if this revert must leave no trace of them.
  }
}
