import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstrumentEntity } from '@forexedge/database';
import Redis from 'ioredis';

export interface PipValueResult {
  pair: string;
  lots: number;
  pipValue: number;
  currency: string;
  pipSize: number;
  calculationPath: 'DIRECT' | 'INDIRECT' | 'CROSS';
}

@Injectable()
export class PipCalculatorService {
  private readonly logger = new Logger(PipCalculatorService.name);

  constructor(
    @InjectRepository(InstrumentEntity)
    private readonly instrumentRepo: Repository<InstrumentEntity>,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  async calculatePipValue(
    pair: string,        // EUR/USD format
    lots: number,
    accountCurrency = 'USD',
  ): Promise<PipValueResult> {
    const instrument = await this.instrumentRepo.findOne({ where: { pair } });
    if (!instrument) throw new NotFoundException(`Instrument ${pair} not found`);

    const [base, quote] = pair.split('/');
    const units = lots * instrument.lotSize;
    const pipSize = Number(instrument.pipSize);

    let pipValue: number;
    let calculationPath: PipValueResult['calculationPath'];

    if (quote === accountCurrency) {
      // Case 1: DIRECT — quote currency is USD (EUR/USD, GBP/USD)
      pipValue = units * pipSize;
      calculationPath = 'DIRECT';

    } else if (base === accountCurrency) {
      // Case 2: INDIRECT — base currency is USD (USD/JPY, USD/CAD)
      const currentPrice = await this.getPriceFromRedis(pair);
      pipValue = (units * pipSize) / currentPrice;
      calculationPath = 'INDIRECT';

    } else {
      // Case 3: CROSS — USD is neither base nor quote (EUR/GBP, GBP/JPY)
      // Calculate pip value in quote currency, then convert to USD
      const pipValueInQuote = units * pipSize;

      // We need quote/USD rate — try quote_USD pair first, then USD_quote inverted
      let quoteToUsd: number;
      try {
        quoteToUsd = await this.getPriceFromRedis(`${quote}/USD`);
      } catch {
        // Invert USD/quote rate
        const usdToQuote = await this.getPriceFromRedis(`USD/${quote}`);
        quoteToUsd = 1 / usdToQuote;
      }

      pipValue = pipValueInQuote * quoteToUsd;
      calculationPath = 'CROSS';
    }

    return {
      pair,
      lots,
      pipValue: Math.round(pipValue * 100) / 100,
      currency: accountCurrency,
      pipSize,
      calculationPath,
    };
  }

  private async getPriceFromRedis(pair: string): Promise<number> {
    // Redis key format is price:EUR_USD (underscore, not slash)
    const key = `price:${pair.replace('/', '_')}`;
    const raw = await this.redis.get(key);

    if (!raw) {
      throw new NotFoundException(`No live price available for ${pair} — is market-service running?`);
    }

    const parsed = JSON.parse(raw);
    // Redis stores { bid, ask, mid, instrument, timestamp }
    return Number(parsed.mid ?? parsed.ask ?? parsed.bid);
  }
}