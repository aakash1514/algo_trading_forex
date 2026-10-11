import { Injectable, NotFoundException } from '@nestjs/common';
import { ValidationResult } from './order-validation.service';
import { PricingService, PositionValuation } from '../pricing/pricing.service';
import { AccountService, type AccountSummaryDto } from '../account/account.service';

const DEFAULT_LEVERAGE = 100;

// Margin and pip value come from the shared money math (libs/common) using the
// instrument's contract spec from the DB; domain-service uses the same functions.
@Injectable()
export class MarginEngineService {
  constructor(
    private readonly accounts: AccountService,
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
    let account: AccountSummaryDto;
    try {
      account = await this.accounts.getAccountSummary(userId);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      return {
        valid: false,
        reason: 'Account not found — call POST /api/account/initialize first',
      };
    }

    const { marginRequired } = await this.valuePosition(pair, lots, entryPrice, account.leverage);
    // Free margin = equity - margin used, with open P&L summed from the positions
    const freeMargin = account.freeMargin;

    if (marginRequired > freeMargin) {
      return {
        valid: false,
        reason: `Insufficient margin: need $${marginRequired.toFixed(2)}, free margin $${freeMargin.toFixed(2)}`,
      };
    }
    return { valid: true };
  }
}
