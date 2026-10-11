import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 4: a read-only group role for the ML service.
// - forexedge_readonly (NOLOGIN) may SELECT the imported history, its scale and
//   coverage, and instruments; nothing else (no users, orders, positions, ...).
// - Roles are cluster-wide while grants are per database, so the role is created
//   only if it doesn't exist yet (a per-run test database migrates against a
//   cluster where it already does); the grants are applied in every database.
// - The login (forexedge_ml) is created outside migrations by
//   tools/ops/create-ml-db-user.ts, so no password is ever in a migration.
// - down() revokes this database's grants but keeps the role: other databases on
//   the cluster (the test databases) may still hold grants to it.
// - Step 7 (managed Postgres): if the provider's admin user can't CREATE ROLE in
//   SQL, create forexedge_readonly in its console first; the IF NOT EXISTS block
//   then skips creation and the grants still apply (they need only table ownership).
export const READONLY_ROLE = 'forexedge_readonly';

export const READONLY_TABLES = [
  'historical_candles',
  'historical_candles_5m',
  'historical_candles_15m',
  'historical_candles_1h',
  'historical_candles_4h',
  'historical_candles_1d',
  'historical_price_scale',
  'historical_coverage',
  'instruments',
];

export class ReadOnlyRole1791900000000 implements MigrationInterface {
  name = 'ReadOnlyRole1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READONLY_ROLE}') THEN
          CREATE ROLE ${READONLY_ROLE} NOLOGIN;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO ${READONLY_ROLE}`);
    await queryRunner.query(`GRANT SELECT ON ${READONLY_TABLES.join(', ')} TO ${READONLY_ROLE}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON ${READONLY_TABLES.join(', ')} FROM ${READONLY_ROLE}`);
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM ${READONLY_ROLE}`);
  }
}
