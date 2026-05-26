import { Injectable, Logger } from '@nestjs/common';
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

  // In-memory cache per userId for tick-frequency updates
  // Structure: userId → AccountSummaryEntity
  private cache = new Map<string, AccountSummaryEntity>();

  // Track last DB write time per userId
  private lastWriteAt = new Map<string, number>();

  // Write-through interval: 5 seconds
  private readonly WRITE_INTERVAL_MS = 5_000;

  constructor(
    @InjectRepository(AccountSummaryEntity)
    private readonly accountRepo: Repository<AccountSummaryEntity>,
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
  ) {}

  // ─── Get account summary with computed fields ──────────────────────────────
  async getAccountSummary(userId: string): Promise<AccountSummaryDto> {
    // Check cache first
    let row = this.cache.get(userId);

    if (!row) {
      const dbRow = await this.accountRepo.findOne({ where: { userId } });
      if (!dbRow) throw new Error(`Account not found for user ${userId}`);
      row = dbRow;
      this.cache.set(userId, row);
    }

    return this.computeSummary(row);
  }

  // ─── Initialize paper account ──────────────────────────────────────────────
  async initializeAccount(userId: string): Promise<AccountSummaryDto> {
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
    this.cache.set(userId, saved);

    this.logger.log(`Paper account initialized for user ${userId} — $10,000 balance`);
    return this.computeSummary(saved);
  }

  // ─── Update unrealized P&L from tick (in-memory, write-through every 5s) ──
  async updateUnrealizedPnl(userId: string, unrealizedPnl: number): Promise<void> {
    let row = this.cache.get(userId);

    if (!row) {
      const dbRow = await this.accountRepo.findOne({ where: { userId } });
      if (!dbRow) return;
      row = dbRow;
    }

    // Update cache
    row.unrealizedPnl = unrealizedPnl;
    this.cache.set(userId, row);

    // Write-through: flush to DB if 5 seconds have passed
    const now = Date.now();
    const lastWrite = this.lastWriteAt.get(userId) ?? 0;

    if (now - lastWrite >= this.WRITE_INTERVAL_MS) {
      await this.flushToDb(userId, row);
    }
  }

  // ─── Force flush to DB (called on position close) ─────────────────────────
  async flushToDb(userId: string, row?: AccountSummaryEntity): Promise<void> {
    const account = row ?? this.cache.get(userId);
    if (!account) return;

    await this.accountRepo.update(
      { userId },
      {
        unrealizedPnl: account.unrealizedPnl,
        marginUsed: account.marginUsed,
        balance: account.balance,
      },
    );

    this.lastWriteAt.set(userId, Date.now());
    this.logger.debug(`Account flushed to DB for user ${userId}`);
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

  // ─── Invalidate cache entry (call after position close) ───────────────────
  invalidateCache(userId: string): void {
    this.cache.delete(userId);
    this.lastWriteAt.delete(userId);
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