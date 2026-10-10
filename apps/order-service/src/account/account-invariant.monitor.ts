import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PAPER_STARTING_BALANCE } from './account.service';

export interface AccountDrift {
  userId: string;
  balance: number;
  expectedBalance: number;
  marginUsed: number;
  expectedMargin: number;
}

// Once a minute, checks every account's stored money against its positions and
// logs each account that drifted:
//   balance     = starting balance + realized P&L of closed positions + swaps
//   margin_used = margin of the open positions
// (Open P&L is not stored, so it can't drift.) Detection only: a drifted
// account needs investigating, not silent "repair".
@Injectable()
export class AccountInvariantMonitor implements OnModuleInit, OnModuleDestroy {
  static readonly INTERVAL_MS = 60_000;
  static readonly TOLERANCE = 0.01;

  private readonly logger = new Logger(AccountInvariantMonitor.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.check().catch((err: Error) => this.logger.error(`Account invariant check failed: ${err.message}`));
    }, AccountInvariantMonitor.INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<AccountDrift[]> {
    const rows = await this.dataSource.query<{
      user_id: string; balance: string; expected_balance: string; margin_used: string; expected_margin: string;
    }[]>(`
      SELECT a.user_id, a.balance, a.margin_used,
             $1::numeric + COALESCE(SUM(p.realized_pnl) FILTER (WHERE NOT p.is_open), 0)
                         + COALESCE(SUM(p.swap_accrued), 0) AS expected_balance,
             COALESCE(SUM(p.margin_used) FILTER (WHERE p.is_open), 0) AS expected_margin
      FROM account_summary a
      LEFT JOIN positions p ON p.user_id = a.user_id
      GROUP BY a.user_id, a.balance, a.margin_used
      HAVING abs(a.balance - ($1::numeric + COALESCE(SUM(p.realized_pnl) FILTER (WHERE NOT p.is_open), 0)
                                          + COALESCE(SUM(p.swap_accrued), 0))) > $2
          OR abs(a.margin_used - COALESCE(SUM(p.margin_used) FILTER (WHERE p.is_open), 0)) > $2
    `, [PAPER_STARTING_BALANCE, AccountInvariantMonitor.TOLERANCE]);

    const drifts = rows.map((r) => ({
      userId: r.user_id,
      balance: Number(r.balance),
      expectedBalance: Number(r.expected_balance),
      marginUsed: Number(r.margin_used),
      expectedMargin: Number(r.expected_margin),
    }));
    for (const d of drifts) {
      this.logger.error(
        `Account drift — user ${d.userId}: balance ${d.balance} (expected ${d.expectedBalance}), ` +
        `margin_used ${d.marginUsed} (expected ${d.expectedMargin})`,
      );
    }
    return drifts;
  }
}
