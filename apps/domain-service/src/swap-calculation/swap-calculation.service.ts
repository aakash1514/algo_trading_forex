import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InstrumentEntity } from '@forexedge/database';
import { SwapRateEntity } from '@forexedge/database';

// Real-world swap rates (pips per lot per day)
// Negative = you pay, Positive = you receive
const SWAP_RATES: Record<string, { long: number; short: number }> = {
  'EUR/USD': { long: -0.52, short:  0.18 },
  'GBP/USD': { long: -0.43, short:  0.11 },
  'USD/JPY': { long:  0.31, short: -0.72 },
  'USD/CHF': { long:  0.21, short: -0.64 },
  'USD/CAD': { long: -0.35, short:  0.08 },
  'AUD/USD': { long: -0.28, short:  0.06 },
  'NZD/USD': { long: -0.22, short:  0.05 },
  'EUR/GBP': { long: -0.18, short:  0.07 },
  'EUR/JPY': { long:  0.14, short: -0.58 },
  'EUR/CHF': { long: -0.12, short: -0.24 },
  'EUR/CAD': { long: -0.41, short:  0.09 },
  'EUR/AUD': { long: -0.56, short:  0.12 },
  'EUR/NZD': { long: -0.61, short:  0.14 },
  'GBP/JPY': { long:  0.22, short: -0.81 },
  'GBP/CHF': { long: -0.09, short: -0.31 },
  'GBP/CAD': { long: -0.48, short:  0.11 },
  'GBP/AUD': { long: -0.63, short:  0.15 },
  'GBP/NZD': { long: -0.68, short:  0.16 },
  'AUD/JPY': { long:  0.18, short: -0.63 },
  'AUD/CHF': { long: -0.14, short: -0.28 },
  'AUD/CAD': { long: -0.32, short:  0.07 },
  'AUD/NZD': { long: -0.19, short:  0.04 },
  'NZD/JPY': { long:  0.12, short: -0.57 },
  'NZD/CHF': { long: -0.11, short: -0.22 },
  'NZD/CAD': { long: -0.27, short:  0.06 },
  'CAD/JPY': { long:  0.16, short: -0.61 },
  'CAD/CHF': { long: -0.08, short: -0.19 },
  'CHF/JPY': { long:  0.09, short: -0.54 },
};

@Injectable()
export class SwapCalculationService {
  private readonly logger = new Logger(SwapCalculationService.name);

  constructor(
    @InjectRepository(InstrumentEntity)
    private readonly instrumentRepo: Repository<InstrumentEntity>,
    @InjectRepository(SwapRateEntity)
    private readonly swapRateRepo: Repository<SwapRateEntity>,
  ) {}

  // 17:00 EST = 22:00 UTC (standard time) / 21:00 UTC (EDT)
  // Using 22:00 UTC — covers both with a 1hr margin
  @Cron('0 22 * * *', { timeZone: 'UTC' })
  async runDailySwap() {
    this.logger.log('Running daily swap calculation...');
    const now = new Date();
    const isWednesday = now.getUTCDay() === 3;

    const instruments = await this.instrumentRepo.find({ where: { isActive: true } });
    let processed = 0;

    for (const instrument of instruments) {
      const rates = SWAP_RATES[instrument.pair];
      if (!rates) {
        this.logger.warn(`No swap rates defined for ${instrument.pair} — skipping`);
        continue;
      }

      const multiplier = isWednesday ? 3 : 1;
      const longRate  = rates.long  * multiplier;
      const shortRate = rates.short * multiplier;

      await this.swapRateRepo.upsert(
        {
          pair:       instrument.pair,
          instrument: instrument.pair.replace('/', '_'),
          longRate,
          shortRate,
          tripleDay:  'WEDNESDAY',
        },
        { conflictPaths: ['instrument'] },
      );

      processed++;
    }

    this.logger.log(
      `Swap calculation complete. ${processed} pairs updated. Wednesday triple: ${isWednesday}`
    );
  }

  async getSwapRate(pair: string): Promise<SwapRateEntity | null> {
    return this.swapRateRepo.findOne({ where: { pair } });
  }

  // Calculates swap charge for a specific position — called by OMS in Phase 4
  calculateSwapCharge(
    pair: string,
    lots: number,
    direction: 'LONG' | 'SHORT',
    isWednesday = false,
  ): number {
    const rates = SWAP_RATES[pair];
    if (!rates) return 0;

    const multiplier = isWednesday ? 3 : 1;
    const rate = direction === 'LONG' ? rates.long : rates.short;
    // Swap charge = rate (pips) × lots
    return Math.round(rate * multiplier * lots * 100) / 100;
  }
}