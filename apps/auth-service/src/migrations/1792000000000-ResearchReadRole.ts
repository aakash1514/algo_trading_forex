import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 5: a group role for the research agent's backtest reads.
// - forexedge_research_reader (NOLOGIN) may SELECT only the listed columns of
//   backtest_runs: the run's inputs, status, timestamps and stored metrics. Not
//   minio_object_key (the trade list lives in MinIO, which the agent doesn't read),
//   error_message or progress. Nothing else.
// - The history comes from the existing forexedge_readonly role (ReadOnlyRole); the
//   login forexedge_research is a member of both. Nothing new is granted to
//   forexedge_readonly, so the ML login (forexedge_ml) still can't read any run.
// - backtest_runs holds every user's runs: the agent scopes each query by the
//   caller's user id itself (the role can't, it is one login for all users).
// - Same pattern as ReadOnlyRole: the role is cluster-wide and created only if it is
//   missing, the grants are per database, down() revokes this database's grants and
//   keeps the role, and the login is created by tools/ops/create-research-db-user.ts
//   (no password in a migration). Step 7: create the role in the provider console if
//   CREATE ROLE isn't allowed in SQL.
export const RESEARCH_READER_ROLE = 'forexedge_research_reader';

export const RESEARCH_BACKTEST_COLUMNS = [
  'id',
  'user_id',
  'strategy_name',
  'instrument',
  'timeframe',
  'from_date',
  'to_date',
  'parameters',
  'initial_capital',
  'lots',
  'status',
  'total_trades',
  'win_rate',
  'profit_factor',
  'sharpe_ratio',
  'max_drawdown_pct',
  'total_pnl',
  'total_pnl_usd',
  'started_at',
  'completed_at',
  'created_at',
];

export class ResearchReadRole1792000000000 implements MigrationInterface {
  name = 'ResearchReadRole1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RESEARCH_READER_ROLE}') THEN
          CREATE ROLE ${RESEARCH_READER_ROLE} NOLOGIN;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO ${RESEARCH_READER_ROLE}`);
    await queryRunner.query(
      `GRANT SELECT (${RESEARCH_BACKTEST_COLUMNS.join(', ')}) ON backtest_runs TO ${RESEARCH_READER_ROLE}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `REVOKE SELECT (${RESEARCH_BACKTEST_COLUMNS.join(', ')}) ON backtest_runs FROM ${RESEARCH_READER_ROLE}`,
    );
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM ${RESEARCH_READER_ROLE}`);
  }
}
