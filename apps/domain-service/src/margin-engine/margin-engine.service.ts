import { Injectable, Logger } from '@nestjs/common';
import { PipCalculatorService } from '../pip-calculator/pip-calculator.service';
import { marginRequiredUsd } from '@forexedge/common';

export enum MarginCallStatus {
  SAFE        = 'SAFE',         // margin level > 150%
  WARNING     = 'WARNING',      // margin level 100–150%
  MARGIN_CALL = 'MARGIN_CALL',  // margin level 50–100%
  STOP_OUT    = 'STOP_OUT',     // margin level < 50%
}

export interface MarginRequiredResult {
  pair: string;
  lots: number;
  leverage: number;
  currentPrice: number;
  marginRequired: number;
  currency: string;
}

export interface MarginLevelResult {
  equity: number;
  totalMarginUsed: number;
  freeMargin: number;
  marginLevel: number;       // percentage
  status: MarginCallStatus;
}

export interface Position {
  pair: string;
  lots: number;
  leverage: number;
  currentPrice: number;
}

@Injectable()
export class MarginEngineService {
  private readonly logger = new Logger(MarginEngineService.name);

  // Margin level thresholds
  private readonly WARNING_LEVEL    = 150;
  private readonly MARGIN_CALL_LEVEL = 100;
  private readonly STOP_OUT_LEVEL   = 50;

  constructor(private readonly pipCalculator: PipCalculatorService) {}

  // margin (USD) = units x base->USD / leverage, with the lot size from the DB.
  // Same shared formula as order-service (libs/common money.ts).
  async calculateMarginRequired(
    pair: string,
    lots: number,
    leverage: number,
    currentPrice: number,
  ): Promise<MarginRequiredResult> {
    const spec = await this.pipCalculator.getContractSpec(pair);
    const quoteToUsd = await this.pipCalculator.getQuoteToUsd(pair, currentPrice);
    const marginRequired = marginRequiredUsd(lots, spec, currentPrice, quoteToUsd, leverage);

    return {
      pair,
      lots,
      leverage,
      currentPrice,
      marginRequired,
      currency: 'USD',
    };
  }

  // Called by OMS to check account health across all open positions
  async calculateMarginLevel(
    accountBalance: number,
    unrealisedPnL: number,
    positions: Position[],
  ): Promise<MarginLevelResult> {
    const equity = accountBalance + unrealisedPnL;

    const margins = await Promise.all(positions.map((pos) =>
      this.calculateMarginRequired(pos.pair, pos.lots, pos.leverage, pos.currentPrice)));
    const totalMarginUsed = margins.reduce((sum, m) => sum + m.marginRequired, 0);

    const freeMargin  = Math.round((equity - totalMarginUsed) * 100) / 100;
    const marginLevel = totalMarginUsed === 0
      ? Infinity
      : Math.round((equity / totalMarginUsed) * 100 * 100) / 100;

    const status = this.getMarginCallStatus(marginLevel);

    if (status === MarginCallStatus.STOP_OUT) {
      this.logger.error(`STOP OUT triggered — margin level: ${marginLevel}%`);
    } else if (status === MarginCallStatus.MARGIN_CALL) {
      this.logger.warn(`MARGIN CALL — margin level: ${marginLevel}%`);
    } else if (status === MarginCallStatus.WARNING) {
      this.logger.warn(`MARGIN WARNING — margin level: ${marginLevel}%`);
    }

    return {
      equity:          Math.round(equity * 100) / 100,
      totalMarginUsed: Math.round(totalMarginUsed * 100) / 100,
      freeMargin,
      marginLevel,
      status,
    };
  }

  // Called by OMS to check if user can afford to open a new position
  async canOpenPosition(
    accountBalance: number,
    unrealisedPnL: number,
    existingPositions: Position[],
    newPosition: Position,
  ): Promise<{ allowed: boolean; reason?: string; freeMargin: number; marginRequired: number }> {
    const { freeMargin } = await this.calculateMarginLevel(
      accountBalance,
      unrealisedPnL,
      existingPositions,
    );

    const { marginRequired } = await this.calculateMarginRequired(
      newPosition.pair,
      newPosition.lots,
      newPosition.leverage,
      newPosition.currentPrice,
    );

    if (freeMargin < marginRequired) {
      return {
        allowed: false,
        reason: `Insufficient free margin. Required: $${marginRequired}, Available: $${freeMargin}`,
        freeMargin,
        marginRequired,
      };
    }

    return { allowed: true, freeMargin, marginRequired };
  }

  private getMarginCallStatus(marginLevel: number): MarginCallStatus {
    if (marginLevel === Infinity || marginLevel > this.WARNING_LEVEL) {
      return MarginCallStatus.SAFE;
    }
    if (marginLevel > this.MARGIN_CALL_LEVEL) {
      return MarginCallStatus.WARNING;
    }
    if (marginLevel > this.STOP_OUT_LEVEL) {
      return MarginCallStatus.MARGIN_CALL;
    }
    return MarginCallStatus.STOP_OUT;
  }
}