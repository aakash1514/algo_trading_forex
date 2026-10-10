import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstrumentEntity, EconomicEventEntity, OrderEntity, PositionEntity } from '@forexedge/database';
import { SPREAD_WIDE_RATIO, isSpreadWide, priceDecimals, spreadRatio } from '@forexedge/common';
import { pairCurrencies } from '../common/instrument';
import type { OrderRequest } from './dto/submit-order.dto';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// The live quote the order is priced at (the same one the margin check uses).
export interface OrderQuote {
  bid: number;
  ask: number;
}

type InstrumentCheck = ValidationResult & { instrument?: InstrumentEntity };

@Injectable()
export class OrderValidationService {
  private readonly logger = new Logger(OrderValidationService.name);

  // Risk limits per spec
  private readonly MAX_LOTS_PER_PAIR = 10;
  private readonly MAX_DAILY_LOSS_USD = 500;

  constructor(
    @InjectRepository(InstrumentEntity)
    private readonly instrumentRepo: Repository<InstrumentEntity>,
    @InjectRepository(EconomicEventEntity)
    private readonly economicEventRepo: Repository<EconomicEventEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
  ) {}

  async validate(
    userId: string,
    dto: OrderRequest,
    quote: OrderQuote,
    marginCheck: () => Promise<ValidationResult>,
  ): Promise<ValidationResult> {
    // Gate 1: Instrument active (instruments are keyed by slash-format pair)
    const gate1 = await this.checkInstrumentActive(dto.pair);
    if (!gate1.valid || !gate1.instrument) return gate1;

    // Gate 2: Spread of the quote being traded, relative to the instrument's norm
    const gate2 = this.checkSpread(gate1.instrument, quote);
    if (!gate2.valid) return gate2;

    // Gate 3: Margin check — injected as a callback to avoid HTTP calls
    const gate3 = await marginCheck();
    if (!gate3.valid) return gate3;

    // Gate 4: Risk limits
    const gate4 = await this.checkRiskLimits(userId, dto.pair, dto.lots);
    if (!gate4.valid) return gate4;

    // Gate 5: Calendar warning — never blocks, only warns
    await this.checkEconomicCalendar(dto.pair);

    return { valid: true };
  }

  // ─── Gate 1 ────────────────────────────────────────────────────────────────
  private async checkInstrumentActive(
    pair: string,
  ): Promise<InstrumentCheck> {
    const record = await this.instrumentRepo.findOne({
      where: { pair },
    });

    if (!record) {
      return { valid: false, reason: `Instrument ${pair} not found` };
    }

    if (!record.isActive) {
      return { valid: false, reason: `Instrument ${pair} is not active` };
    }

    return { valid: true, instrument: record };
  }

  // ─── Gate 2 ────────────────────────────────────────────────────────────────
  // Judged on the quote the order is priced at, so there is no cached status to
  // go stale. WIDE means strictly more than SPREAD_WIDE_RATIO x avg_spread (the
  // same rule domain-service uses for its alerts). Fails closed if the
  // instrument has no average spread: the gate must never silently pass.
  private checkSpread(instrument: InstrumentEntity, quote: OrderQuote): ValidationResult {
    const avgSpread = Number(instrument.avgSpread);
    if (!(avgSpread > 0)) {
      this.logger.error(`No average spread configured for ${instrument.pair}`);
      return { valid: false, reason: `Spread check unavailable for ${instrument.pair}: no average spread configured` };
    }

    const ratio = spreadRatio(quote.bid, quote.ask, avgSpread);
    if (isSpreadWide(ratio)) {
      const dp = priceDecimals({ pipSize: Number(instrument.pipSize) });
      return {
        valid: false,
        reason: `Spread too wide for ${instrument.pair}: ${(quote.ask - quote.bid).toFixed(dp)} is ${ratio}x `
          + `the average ${avgSpread} (limit ${SPREAD_WIDE_RATIO}x)`,
      };
    }

    return { valid: true };
  }

  // ─── Gate 3 ────────────────────────────────────────────────────────────────
  // Margin check is passed in as a callback from OrderService.
  // OrderService calls MarginEngineService.canOpenPosition() locally —
  // no HTTP call to domain-service, no network failure point.

  // ─── Gate 4 ────────────────────────────────────────────────────────────────
  private async checkRiskLimits(
    userId: string,
    pair: string,
    lots: number,
  ): Promise<ValidationResult> {
    // Rule 1: open exposure on the pair (gross LONG + SHORT lots) plus this
    // order must not exceed 10 lots
    const exposure = await this.positionRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.lots), 0)', 'openLots')
      .where('p.user_id = :userId', { userId })
      .andWhere('p.pair = :pair', { pair })
      .andWhere('p.is_open = true')
      .getRawOne<{ openLots: string }>();
    const openLots = Number(exposure?.openLots ?? 0);
    if (openLots + lots > this.MAX_LOTS_PER_PAIR) {
      return {
        valid: false,
        reason: `Exposure limit: ${openLots} lots open on ${pair} + ${lots} would exceed ${this.MAX_LOTS_PER_PAIR} lots per pair`,
      };
    }

    // Rule 2: daily realized loss must not exceed $500
    // "Today" is the UTC trading day, independent of the server's timezone
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Sum all closed orders today where the position lost money
    const result = await this.orderRepo
      .createQueryBuilder('o')
      .select('SUM(pos.realized_pnl)', 'totalPnl')
      .innerJoin('positions', 'pos', 'pos.order_id = o.id')
      .where('o.user_id = :userId', { userId })
      .andWhere('o.status = :status', { status: 'CLOSED' })
      .andWhere('o.closed_at >= :todayStart', { todayStart })
      .andWhere('pos.realized_pnl < 0')
      .getRawOne<{ totalPnl: string }>();

    const dailyLoss = Math.abs(parseFloat(result?.totalPnl ?? '0'));

    if (dailyLoss >= this.MAX_DAILY_LOSS_USD) {
      return {
        valid: false,
        reason: `Daily loss limit reached: $${dailyLoss.toFixed(2)} (max $${this.MAX_DAILY_LOSS_USD})`,
      };
    }

    return { valid: true };
  }

  // ─── Gate 5 ────────────────────────────────────────────────────────────────
  private async checkEconomicCalendar(pair: string): Promise<void> {
    const currencies = pairCurrencies(pair);

    const now = new Date();
    const windowMinutes = 30;
    const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);
    const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000);

    const events = await this.economicEventRepo
      .createQueryBuilder('e')
      .where('e.currency IN (:...currencies)', { currencies })
      .andWhere('e.scheduled_at BETWEEN :windowStart AND :windowEnd', {
        windowStart,
        windowEnd,
      })
      .andWhere('e.impact IN (:...impacts)', { impacts: ['HIGH', 'MEDIUM'] })
      .getMany();

    if (events.length > 0) {
      const names = events.map(e => `${e.currency} ${e.title}`).join(', ');
      this.logger.warn(
        `⚠️  Economic events near order time for ${pair}: ${names}`,
      );
    }
  }
}