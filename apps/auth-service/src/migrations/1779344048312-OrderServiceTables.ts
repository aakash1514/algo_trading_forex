import { MigrationInterface, QueryRunner } from "typeorm";

export class OrderServiceTables1779344048312 implements MigrationInterface {
    name = 'OrderServiceTables1779344048312'

   async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE orders (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key   VARCHAR(100) UNIQUE NOT NULL,
        user_id           UUID NOT NULL REFERENCES users(id),
        instrument        VARCHAR(10) NOT NULL,
        pair              VARCHAR(7) NOT NULL,
        direction         VARCHAR(5) NOT NULL CHECK (direction IN ('LONG','SHORT')),
        order_type        VARCHAR(20) NOT NULL
                            CHECK (order_type IN ('MARKET','LIMIT','STOP','TRAILING_STOP','OCO')),
        lots              DECIMAL(8,2) NOT NULL,
        requested_price   DECIMAL(18,6),
        executed_price    DECIMAL(18,6),
        stop_loss         DECIMAL(18,6),
        take_profit       DECIMAL(18,6),
        status            VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','PENDING','SUBMITTED','OPEN',
                                              'CLOSED','REJECTED','CANCELLED')),
        session_opened    VARCHAR(20),
        pip_value         DECIMAL(10,4),
        margin_used       DECIMAL(12,2),
        rejection_reason  TEXT,
        submitted_at      TIMESTAMPTZ,
        opened_at         TIMESTAMPTZ,
        closed_at         TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT now(),
        updated_at        TIMESTAMPTZ DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE positions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id        UUID NOT NULL REFERENCES orders(id),
        user_id         UUID NOT NULL REFERENCES users(id),
        instrument      VARCHAR(10) NOT NULL,
        pair            VARCHAR(7) NOT NULL,
        direction       VARCHAR(5) NOT NULL CHECK (direction IN ('LONG','SHORT')),
        lots            DECIMAL(8,2) NOT NULL,
        open_price      DECIMAL(18,6) NOT NULL,
        current_price   DECIMAL(18,6),
        pip_pnl         DECIMAL(10,2) DEFAULT 0,
        unrealized_pnl  DECIMAL(12,2) DEFAULT 0,
        realized_pnl    DECIMAL(12,2),
        swap_accrued    DECIMAL(10,4) DEFAULT 0,
        pip_value       DECIMAL(10,4) NOT NULL,
        margin_used     DECIMAL(12,2) NOT NULL,
        stop_loss       DECIMAL(18,6),
        take_profit     DECIMAL(18,6),
        is_open         BOOLEAN DEFAULT true,
        opened_at       TIMESTAMPTZ DEFAULT now(),
        closed_at       TIMESTAMPTZ,
        close_reason    VARCHAR(50)
                          CHECK (close_reason IN ('MANUAL','STOP_LOSS','TAKE_PROFIT','MARGIN_CALL'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE account_summary (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID NOT NULL REFERENCES users(id) UNIQUE,
        balance         DECIMAL(15,2) NOT NULL DEFAULT 10000.00,
        margin_used     DECIMAL(15,2) NOT NULL DEFAULT 0,
        unrealized_pnl  DECIMAL(12,2) NOT NULL DEFAULT 0,
        leverage        INTEGER NOT NULL DEFAULT 100,
        updated_at      TIMESTAMPTZ DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS account_summary`);
    await queryRunner.query(`DROP TABLE IF EXISTS positions`);
    await queryRunner.query(`DROP TABLE IF EXISTS orders`);
  }

}
