import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 6b-1: bar replay (replay-service) over the imported history.
// - replay_sessions: one replay per row. clock_time is the last processed M1 minute;
//   at most one session per user is not ENDED (partial unique index).
// - replay_positions: market orders and the positions they become. Prices are
//   integer points at the pair's historical_price_scale, like the history. An order
//   is PENDING until the next processed minute fills it at that minute's open
//   (the backtester's next-open rule), then OPEN, then CLOSED; a PENDING order can be
//   CANCELLED. The status checks keep each state's columns consistent.
// - forexedge_replay_writer (NOLOGIN) may SELECT, INSERT and UPDATE the replay_*
//   tables only; nothing is ever deleted. The login forexedge_replay is a member of it
//   and of forexedge_readonly (the history, its scale and coverage, instruments), and
//   is created by tools/ops/create-replay-db-user.ts (no password in a migration).
//   Same pattern as ReadOnlyRole: the role is created only if missing (roles are
//   cluster-wide), grants are per database, down() revokes them and keeps the role.
export const REPLAY_WRITER_ROLE = 'forexedge_replay_writer';
export const REPLAY_TABLES = ['replay_sessions', 'replay_positions'];

export class ReplayTables1792500000000 implements MigrationInterface {
  name = 'ReplayTables1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE replay_sessions (
        id               uuid          NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
        user_id          uuid          NOT NULL REFERENCES users (id),
        pair             varchar(7)    NOT NULL
          CONSTRAINT replay_sessions_pair_check CHECK (pair IN ('EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD')),
        start_time       timestamptz   NOT NULL,
        clock_time       timestamptz   NOT NULL,
        status           varchar(7)    NOT NULL DEFAULT 'PAUSED'
          CONSTRAINT replay_sessions_status_check CHECK (status IN ('PLAYING', 'PAUSED', 'ENDED')),
        speed_ms         integer       NOT NULL DEFAULT 1000
          CONSTRAINT replay_sessions_speed_check CHECK (speed_ms IN (500, 1000, 2000)),
        timeframe        varchar(3)    NOT NULL
          CONSTRAINT replay_sessions_timeframe_check CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
        starting_balance numeric(14,2) NOT NULL DEFAULT 10000
          CONSTRAINT replay_sessions_starting_balance_check CHECK (starting_balance BETWEEN 100 AND 10000000),
        balance          numeric(14,2) NOT NULL,
        created_at       timestamptz   NOT NULL DEFAULT now(),
        updated_at       timestamptz   NOT NULL DEFAULT now(),
        ended_at         timestamptz   NULL,
        CONSTRAINT replay_sessions_ended_check CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX replay_sessions_one_active_per_user ON replay_sessions (user_id) WHERE status <> 'ENDED'
    `);
    await queryRunner.query(`COMMENT ON COLUMN replay_sessions.clock_time IS 'Last processed M1 minute (historical_candles.time)'`);
    await queryRunner.query(`COMMENT ON COLUMN replay_sessions.balance IS 'USD: starting_balance + realized P&L of the closed positions'`);

    await queryRunner.query(`
      CREATE TABLE replay_positions (
        id                 uuid          NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
        session_id         uuid          NOT NULL REFERENCES replay_sessions (id),
        side               varchar(4)    NOT NULL CONSTRAINT replay_positions_side_check CHECK (side IN ('BUY', 'SELL')),
        lots               numeric(8,2)  NOT NULL CONSTRAINT replay_positions_lots_check CHECK (lots BETWEEN 0.01 AND 100),
        units              integer       NOT NULL CONSTRAINT replay_positions_units_check CHECK (units > 0),
        status             varchar(9)    NOT NULL
          CONSTRAINT replay_positions_status_check CHECK (status IN ('PENDING', 'OPEN', 'CLOSED', 'CANCELLED')),
        placed_at          timestamptz   NOT NULL,
        stop_loss_points   integer       NULL,
        take_profit_points integer       NULL,
        margin_usd         numeric(14,2) NOT NULL CONSTRAINT replay_positions_margin_check CHECK (margin_usd >= 0),
        entry_time         timestamptz   NULL,
        entry_points       integer       NULL,
        exit_requested_at  timestamptz   NULL,
        exit_time          timestamptz   NULL,
        exit_points        integer       NULL,
        exit_reason        varchar(11)   NULL
          CONSTRAINT replay_positions_exit_reason_check CHECK (exit_reason IN ('SL', 'TP', 'MANUAL', 'SESSION_END')),
        realized_pnl_usd   numeric(14,2) NULL,
        cancelled_at       timestamptz   NULL,
        created_at         timestamptz   NOT NULL DEFAULT now(),
        updated_at         timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT replay_positions_state_check CHECK (
          CASE status
            WHEN 'PENDING'   THEN entry_time IS NULL AND entry_points IS NULL AND exit_time IS NULL AND cancelled_at IS NULL
            WHEN 'OPEN'      THEN entry_time IS NOT NULL AND entry_points IS NOT NULL AND exit_time IS NULL AND cancelled_at IS NULL
            WHEN 'CLOSED'    THEN entry_time IS NOT NULL AND entry_points IS NOT NULL AND exit_time IS NOT NULL
                                  AND exit_points IS NOT NULL AND exit_reason IS NOT NULL AND realized_pnl_usd IS NOT NULL
            WHEN 'CANCELLED' THEN entry_time IS NULL AND cancelled_at IS NOT NULL
          END
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX replay_positions_session_status ON replay_positions (session_id, status)`);
    await queryRunner.query(`COMMENT ON COLUMN replay_positions.realized_pnl_usd IS 'Net USD (round-trip commission deducted)'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${REPLAY_WRITER_ROLE}') THEN
          CREATE ROLE ${REPLAY_WRITER_ROLE} NOLOGIN;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO ${REPLAY_WRITER_ROLE}`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON ${REPLAY_TABLES.join(', ')} TO ${REPLAY_WRITER_ROLE}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT, INSERT, UPDATE ON ${REPLAY_TABLES.join(', ')} FROM ${REPLAY_WRITER_ROLE}`);
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM ${REPLAY_WRITER_ROLE}`);
    await queryRunner.query(`DROP TABLE replay_positions`);
    await queryRunner.query(`DROP TABLE replay_sessions`);
  }
}
