import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstrumentEntity, EconomicEventEntity, OrderEntity } from '@forexedge/database';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface SubmitOrderDto {
  instrument: string;
  pair: string;
  direction: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'TRAILING_STOP' | 'OCO';
  lots: number;
  requestedPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

@Injectable()
export class OrderValidationService {
  private readonly logger = new Logger(OrderValidationService.name);

  // Populated by Kafka consumer order-service-spread-monitor
  // key: pair (e.g. 'EURUSD'), value: current spread in pips
  private spreadCache = new Map<string, number>();

  // Maximum allowed spread per pair in pips before orders are blocked
  private readonly MAX_SPREAD_PIPS = 5;

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
  ) {}

  // Called by Kafka consumer in Step 10
  updateSpreadCache(pair: string, spreadPips: number): void {
    this.spreadCache.set(pair, spreadPips);
  }

  async validate(
    userId: string,
    dto: SubmitOrderDto,
    marginCheck: () => Promise<ValidationResult>,
  ): Promise<ValidationResult> {
    // Gate 1: Instrument active
    const gate1 = await this.checkInstrumentActive(dto.instrument);
    if (!gate1.valid) return gate1;

    // Gate 2: Spread check
    const gate2 = this.checkSpread(dto.pair);
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
    instrument: string,
  ): Promise<ValidationResult> {
    const record = await this.instrumentRepo.findOne({
      where: { pair: instrument },
    });

    if (!record) {
      return { valid: false, reason: `Instrument ${instrument} not found` };
    }

    if (!record.isActive) {
      return { valid: false, reason: `Instrument ${instrument} is not active` };
    }

    return { valid: true };
  }

  // ─── Gate 2 ────────────────────────────────────────────────────────────────
  private checkSpread(pair: string): ValidationResult {
    const spread = this.spreadCache.get(pair);

    if (spread === undefined) {
      // No spread data yet — allow through with a warning log
      // Prevents blocking all orders on service startup before first Kafka message
      this.logger.warn(`No spread data cached for ${pair} — allowing order through`);
      return { valid: true };
    }

    if (spread > this.MAX_SPREAD_PIPS) {
      return {
        valid: false,
        reason: `Spread too wide for ${pair}: ${spread} pips (max ${this.MAX_SPREAD_PIPS})`,
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
    // Rule 1: lots per pair must not exceed 10
    if (lots > this.MAX_LOTS_PER_PAIR) {
      return {
        valid: false,
        reason: `Lot size ${lots} exceeds maximum ${this.MAX_LOTS_PER_PAIR} lots per pair`,
      };
    }

    // Rule 2: daily realized loss must not exceed $500
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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
    // Extract the two currencies from the pair e.g. EURUSD → ['EUR', 'USD']
    const currencies = [pair.slice(0, 3), pair.slice(3, 6)];

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