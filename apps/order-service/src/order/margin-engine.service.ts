import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountSummaryEntity } from '@forexedge/database';
import { ValidationResult } from './order-validation.service';
import { PricingService, PositionValuation } from '../pricing/pricing.service';

const DEFAULT_LEVERAGE = 100;

// Margin and pip value come from the shared money math (libs/common) using the
// instrument's contract spec from the DB; domain-service uses the same functions.
@Injectable()
export class MarginEngineService {
  constructor(
    @InjectRepository(AccountSummaryEntity)
    private readonly accountRepo: Repository<AccountSummaryEntity>,
    private readonly pricing: PricingService,
  ) {}

  valuePosition(pair: string, lots: number, price: number, leverage = DEFAULT_LEVERAGE): Promise<PositionValuation> {
    return this.pricing.valuePosition(pair, lots, price, leverage);
  }

  // `entryPrice` must be the live price the order would fill at (ask for LONG, bid for SHORT).
  async canOpenPosition(
    userId: string,
    pair: string,
    lots: number,
    entryPrice: number,
  ): Promise<ValidationResult> {
    const account = await this.accountRepo.findOne({ where: { userId } });
    if (!account) {
      return {
        valid: false,
        reason: 'Account not found — call POST /api/account/initialize first',
      };
    }

    const { marginRequired } = await this.valuePosition(pair, lots, entryPrice, account.leverage);
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
