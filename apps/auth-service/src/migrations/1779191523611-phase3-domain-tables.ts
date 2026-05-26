import { MigrationInterface, QueryRunner } from "typeorm";

export class Phase3DomainTables1779191523611 implements MigrationInterface {
    name = 'Phase3DomainTables1779191523611'

    public async up(queryRunner: QueryRunner): Promise<void> {
  // Add missing columns to instruments table
  await queryRunner.query(`
    ALTER TABLE instruments
    ADD COLUMN IF NOT EXISTS pip_size DECIMAL(10,6) NOT NULL DEFAULT 0.0001,
    ADD COLUMN IF NOT EXISTS pip_decimal_places INTEGER NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS avg_spread DECIMAL(10,6) NOT NULL DEFAULT 0.00015
  `);

  // JPY pairs use pip_size 0.01, pip_decimal_places 2
  await queryRunner.query(`
    UPDATE instruments
    SET pip_size = 0.01, pip_decimal_places = 2, avg_spread = 0.015
    WHERE pair LIKE '%/JPY'
  `);

  // Create swap_rates table
  await queryRunner.query(`
    CREATE TABLE swap_rates (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pair         VARCHAR(7) NOT NULL,
      instrument   VARCHAR(10) NOT NULL UNIQUE,
      long_rate    DECIMAL(10,5) NOT NULL,
      short_rate   DECIMAL(10,5) NOT NULL,
      triple_day   VARCHAR(10) NOT NULL DEFAULT 'WEDNESDAY',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Create economic_events table
  await queryRunner.query(`
    CREATE TABLE economic_events (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title         VARCHAR(200) NOT NULL,
      currency      CHAR(3) NOT NULL,
      impact        VARCHAR(10) NOT NULL,
      scheduled_at  TIMESTAMPTZ NOT NULL,
      forecast      VARCHAR(50),
      previous      VARCHAR(50),
      actual        VARCHAR(50),
      created_at    TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Index for calendar queries
  await queryRunner.query(`
    CREATE INDEX idx_economic_events_scheduled_at ON economic_events(scheduled_at);
    CREATE INDEX idx_economic_events_currency ON economic_events(currency);
    CREATE INDEX idx_swap_rates_instrument ON swap_rates(instrument);
  `);
}

public async down(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`DROP INDEX IF EXISTS idx_swap_rates_instrument`);
  await queryRunner.query(`DROP INDEX IF EXISTS idx_economic_events_currency`);
  await queryRunner.query(`DROP INDEX IF EXISTS idx_economic_events_scheduled_at`);
  await queryRunner.query(`DROP TABLE IF EXISTS economic_events`);
  await queryRunner.query(`DROP TABLE IF EXISTS swap_rates`);
  await queryRunner.query(`
    ALTER TABLE instruments
    DROP COLUMN IF EXISTS avg_spread,
    DROP COLUMN IF EXISTS pip_decimal_places,
    DROP COLUMN IF EXISTS pip_size
  `);
}

}
