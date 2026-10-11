import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertUserId } from '@forexedge/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountSummaryEntity, PositionEntity } from '@forexedge/database';

// Every paper account starts with this balance (and has no deposits), which
// the invariant monitor relies on: balance = start + realized P&L + swaps.
export const PAPER_STARTING_BALANCE = 10000;

export interface AccountSummaryDto {
  id: string;
  userId: string;
  balance: number;
  marginUsed: number;
  unrealizedPnl: number;
  leverage: number;
  // Computed fields — never stored in DB
  equity: number;
  freeMargin: number;
  marginLevel: number | null;
  updatedAt: Date;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(AccountSummaryEntity)
    private readonly accountRepo: Repository<AccountSummaryEntity>,
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
  ) {}

  // ─── Get account summary with computed fields ──────────────────────────────
  // balance and margin_used come from the row; open P&L is the sum of the
  // user's open positions (never stored, so it can't drift); equity, free
  // margin and margin level are derived from those. Read fresh on every call.
  async getAccountSummary(userId: string): Promise<AccountSummaryDto> {
    assertUserId(userId);
    const row = await this.accountRepo.findOne({ where: { userId } });
    if (!row) throw new NotFoundException('Account not found — call POST /api/account/initialize first');
    return this.computeSummary(row, await this.openPnl(userId));
  }

  // ─── Initialize paper account ──────────────────────────────────────────────
  async initializeAccount(userId: string): Promise<AccountSummaryDto> {
    assertUserId(userId);
    const existing = await this.accountRepo.findOne({ where: { userId } });
    if (existing) {
      this.logger.log(`Account already exists for user ${userId}`);
      return this.computeSummary(existing, await this.openPnl(userId));
    }

    const account = this.accountRepo.create({
      userId,
      balance: PAPER_STARTING_BALANCE,
      marginUsed: 0,
      leverage: 100,
    });

    const saved = await this.accountRepo.save(account);

    this.logger.log(`Paper account initialized for user ${userId} — $${PAPER_STARTING_BALANCE} balance`);
    return this.computeSummary(saved, 0);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────
  private async openPnl(userId: string): Promise<number> {
    const row = await this.positionRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.unrealized_pnl), 0)', 'openPnl')
      .where('p.user_id = :userId', { userId })
      .andWhere('p.is_open = true')
      .getRawOne<{ openPnl: string }>();
    return Number(row?.openPnl ?? 0);
  }

  private computeSummary(row: AccountSummaryEntity, unrealizedPnl: number): AccountSummaryDto {
    const balance = Number(row.balance);
    const marginUsed = Number(row.marginUsed);

    const equity = Math.round((balance + unrealizedPnl) * 100) / 100;
    const freeMargin = Math.round((equity - marginUsed) * 100) / 100;
    const marginLevel = marginUsed > 0
      ? Math.round((equity / marginUsed) * 100 * 100) / 100
      : null;

    return {
      id: row.id,
      userId: row.userId,
      balance,
      marginUsed,
      unrealizedPnl,
      leverage: row.leverage,
      equity,
      freeMargin,
      marginLevel,
      updatedAt: row.updatedAt,
    };
  }
}
