import { MigrationInterface, QueryRunner } from 'typeorm';

// Extensions the schema depends on: uuid_generate_v4() defaults (uuid-ossp) and
// hypertables/continuous aggregates (timescaledb). They used to exist only
// because the local database had them, so the migrations couldn't build an
// empty database (the integration-test database, a fresh deployment).
// Timestamped before InitialSchema; IF NOT EXISTS keeps it a no-op where the
// extensions are already installed.
export class Extensions1778760074700 implements MigrationInterface {
  name = 'Extensions1778760074700';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
  }

  public async down(): Promise<void> {
    // Intentionally empty: the extensions may predate this migration, and
    // dropping them would drop every object built on them.
  }
}
