import { MigrationInterface, QueryRunner } from 'typeorm';

export class BacktestRuns1779798548771 implements MigrationInterface {
  name = 'BacktestRuns1779798548771';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE backtest_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        strategy_name VARCHAR(100) NOT NULL,
        instrument VARCHAR(10) NOT NULL,
        timeframe VARCHAR(5) NOT NULL
          CHECK (timeframe IN ('1m','5m','15m','1h','4h','1d')),
        from_date TIMESTAMPTZ NOT NULL,
        to_date TIMESTAMPTZ NOT NULL,
        parameters JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
          CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
        progress INTEGER DEFAULT 0,
        total_trades INTEGER,
        win_rate DECIMAL(5,2),
        profit_factor DECIMAL(8,4),
        sharpe_ratio DECIMAL(8,4),
        max_drawdown_pct DECIMAL(8,4),
        total_pnl DECIMAL(12,2),
        minio_object_key TEXT,
        error_message TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_backtest_runs_user_id ON backtest_runs(user_id)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_backtest_runs_status ON backtest_runs(status)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS backtest_runs`);
  }
}