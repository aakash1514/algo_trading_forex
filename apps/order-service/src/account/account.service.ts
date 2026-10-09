import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertUserId } from '@forexedge/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountSummaryEntity, PositionEntity } from '@forexedge/database';

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
  // Always reads the row: positions, fills and closes write account_summary
  // directly, so an in-process cache would serve stale margin/P&L (including
  // to the margin-call check).
  async getAccountSummary(userId: string): Promise<AccountSummaryDto> {
    assertUserId(userId);
    const row = await this.accountRepo.findOne({ where: { userId } });
    if (!row) throw new NotFoundException('Account not found — call POST /api/account/initialize first');
    return this.computeSummary(row);
  }

  // ─── Initialize paper account ──────────────────────────────────────────────
  async initializeAccount(userId: string): Promise<AccountSummaryDto> {
    assertUserId(userId);
    // INSERT ... ON CONFLICT DO NOTHING — idempotent
    const existing = await this.accountRepo.findOne({ where: { userId } });
    if (existing) {
      this.logger.log(`Account already exists for user ${userId}`);
      return this.computeSummary(existing);
    }

    const account = this.accountRepo.create({
      userId,
      balance: 10000.00,
      marginUsed: 0,
      unrealizedPnl: 0,
      leverage: 100,
    });

    const saved = await this.accountRepo.save(account);

    this.logger.log(`Paper account initialized for user ${userId} — $10,000 balance`);
    return this.computeSummary(saved);
  }

  // ─── Margin call check ─────────────────────────────────────────────────────
  async checkMarginCall(userId: string): Promise<void> {
    const summary = await this.getAccountSummary(userId);

    if (summary.marginLevel === null) return; // no open positions

    if (summary.marginLevel < 50) {
      this.logger.error(
        `STOP OUT — user ${userId} margin level ${summary.marginLevel.toFixed(2)}% — closing all positions`,
      );
      await this.closeAllPositions(userId);
      return;
    }

    if (summary.marginLevel < 100) {
      this.logger.warn(
        `MARGIN CALL — user ${userId} margin level ${summary.marginLevel.toFixed(2)}%`,
      );
      return;
    }

    if (summary.marginLevel < 150) {
      this.logger.warn(
        `MARGIN WARNING — user ${userId} margin level ${summary.marginLevel.toFixed(2)}%`,
      );
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────
  private computeSummary(row: AccountSummaryEntity): AccountSummaryDto {
    const balance = Number(row.balance);
    const marginUsed = Number(row.marginUsed);
    const unrealizedPnl = Number(row.unrealizedPnl);

    const equity = balance + unrealizedPnl;
    const freeMargin = equity - marginUsed;
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

  private async closeAllPositions(userId: string): Promise<void> {
    // Mark all open positions for this user — PositionService.closePosition()
    // handles the actual closing logic. Here we just flag them so the
    // next tick triggers closure via PositionService.
    await this.positionRepo.update(
      { userId, isOpen: true },
      { closeReason: 'MARGIN_CALL' },
    );
    this.logger.error(`All positions flagged for closure — user ${userId}`);
  }
}