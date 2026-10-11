import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 3: backtest results in money.
// - initial_capital (USD) and lots are the run's inputs; every run has both.
// - total_pnl_usd is the net P&L in USD (null until the run completes).
//   total_pnl stays the net P&L in pips. Final equity is derived
//   (initial_capital + total_pnl_usd) and not stored.
// - max_drawdown_pct and sharpe_ratio now come from the USD equity curve.
//
// Runs made before step 3 have pip-only results that these columns can't
// describe, so this migration refuses to run while any run exists: back them up
// and delete them first with tools/ops/purge-pip-backtest-runs.ts --apply.
// down() refuses for the same reason (it would drop the inputs of every run).
export class BacktestRunMoney1791800000000 implements MigrationInterface {
  name = 'BacktestRunMoney1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.refuseIfRuns(queryRunner,
      'back them up and delete them first: npx ts-node --transpile-only tools/ops/purge-pip-backtest-runs.ts --apply');
    await queryRunner.query(`
      ALTER TABLE backtest_runs
        ADD COLUMN initial_capital NUMERIC(14,2) NOT NULL
          CONSTRAINT backtest_runs_initial_capital_check CHECK (initial_capital BETWEEN 100 AND 10000000),
        ADD COLUMN lots            NUMERIC(8,2)  NOT NULL
          CONSTRAINT backtest_runs_lots_check CHECK (lots BETWEEN 0.01 AND 100),
        ADD COLUMN total_pnl_usd   NUMERIC(14,2) NULL
    `);
    await queryRunner.query(`COMMENT ON COLUMN backtest_runs.total_pnl IS 'Net P&L in pips'`);
    await queryRunner.query(`COMMENT ON COLUMN backtest_runs.total_pnl_usd IS 'Net P&L in USD'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.refuseIfRuns(queryRunner, 'their initial capital, lots and USD results would be lost');
    await queryRunner.query(`COMMENT ON COLUMN backtest_runs.total_pnl IS NULL`);
    await queryRunner.query(`
      ALTER TABLE backtest_runs DROP COLUMN total_pnl_usd, DROP COLUMN lots, DROP COLUMN initial_capital
    `);
  }

  private async refuseIfRuns(queryRunner: QueryRunner, reason: string): Promise<void> {
    const [{ n }] = await queryRunner.query(`SELECT count(*)::int AS n FROM backtest_runs`);
    if (n > 0) throw new Error(`backtest_runs has ${n} run(s); ${reason}`);
  }
}
