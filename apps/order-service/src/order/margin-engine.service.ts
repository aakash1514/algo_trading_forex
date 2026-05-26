import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountSummaryEntity, PositionEntity } from '@forexedge/database';
import { ValidationResult } from './order-validation.service';

@Injectable()
export class MarginEngineService {
  constructor(
    @InjectRepository(AccountSummaryEntity)
    private readonly accountRepo: Repository<AccountSummaryEntity>,
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
  ) {}

  // ─── Pure math (mirrors domain-service MarginEngineService) ────────────────
  // These three methods are stateless arithmetic — safe to duplicate.
  // domain-service owns the canonical copy; if the formula changes, update both.

  calculateMarginRequired(
    lots: number,
    currentPrice: number,
    leverage: number,
  ): number {
    const notionalValue = lots * 100_000 * currentPrice;
    return Math.round((notionalValue / leverage) * 100) / 100;
  }

  calculatePipValue(pair: string, lots: number, currentPrice: number): number {
    // Synchronous approximation for stamping pipValue on order record at fill time.
    // Full async version with Redis cross-rate lookup lives in PipCalculatorService.
    const isJpy = pair.includes('JPY');
    const pipSize = isJpy ? 0.01 : 0.0001;
    const units = lots * 100_000;

    if (pair.endsWith('USD')) {
      // Direct pair — pip value already in USD
      return Math.round(units * pipSize * 100) / 100;
    }
    // Indirect/cross — divide by current price to approximate USD value
    return Math.round(((units * pipSize) / currentPrice) * 100) / 100;
  }

  // ─── DB-aware check ────────────────────────────────────────────────────────
  async canOpenPosition(
    userId: string,
    lots: number,
    currentPrice: number,
    pair: string,
  ): Promise<ValidationResult> {
    const account = await this.accountRepo.findOne({ where: { userId } });

    if (!account) {
      return {
        valid: false,
        reason: 'Account not found — call POST /api/account/initialize first',
      };
    }

    const marginRequired = this.calculateMarginRequired(
      lots,
      currentPrice,
      account.leverage,
    );

    const equity = Number(account.balance) + Number(account.unrealizedPnl);
    const freeMargin = equity - Number(account.marginUsed);

    if (marginRequired > freeMargin) {
      return {
        valid: false,
        reason: `Insufficient margin: need $${marginRequired.toFixed(2)}, free margin $${freeMargin.toFixed(2)}`,
      };
    }

    return { valid: true };
  }
}