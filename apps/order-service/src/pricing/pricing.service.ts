import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Redis } from 'ioredis';
import { InstrumentEntity } from '@forexedge/database';
import {
  marginRequiredUsd, pipValueUsd, positionUnits, quoteToUsdRate, toContractSpec, type ContractSpec,
  type InstrumentKind,
} from '@forexedge/common';
import { REDIS_CLIENT } from '../redis/redis.module';

export interface LiveQuote {
  bid: number;
  ask: number;
  mid: number;
}

export interface PositionValuation {
  units: number;
  marginRequired: number; // USD
  pipValue: number;       // USD per pip for the whole position
  quoteToUsd: number;
}

export class PriceUnavailableError extends Error {}

// Live prices (Redis, written by market-service) and contract specs (DB).
@Injectable()
export class PricingService {
  // Instruments are static reference data, so caching them is safe.
  private readonly specs = new Map<string, ContractSpec>();
  private readonly kinds = new Map<string, InstrumentKind>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(InstrumentEntity)
    private readonly instrumentRepo: Repository<InstrumentEntity>,
  ) {}

  async getSpec(pair: string): Promise<ContractSpec> {
    const cached = this.specs.get(pair);
    if (cached) return cached;

    const instrument = await this.instrumentRepo.findOne({ where: { pair } });
    if (!instrument) throw new Error(`Instrument ${pair} not found`);
    const spec = toContractSpec(instrument);
    this.specs.set(pair, spec);
    this.kinds.set(pair, instrument.type as InstrumentKind);
    return spec;
  }

  // instruments.type: METAL instruments keep their own market hours.
  async getInstrumentKind(pair: string): Promise<InstrumentKind> {
    const cached = this.kinds.get(pair);
    if (cached) return cached;
    await this.getSpec(pair);
    return this.kinds.get(pair) as InstrumentKind;
  }

  // pair in slash format (EUR/USD); Redis keys use the underscore format.
  // Live price: the key expires 2 s after the last tick, so nothing fills on a
  // stale price (e.g. while the market is closed and the feed is silent).
  async getQuote(pair: string): Promise<LiveQuote> {
    const raw = await this.redis.get(`price:${pair.replace('/', '_')}`);
    if (!raw) throw new PriceUnavailableError(`No live price for ${pair}. Is market-service running?`);
    const { bid, ask, mid } = JSON.parse(raw) as LiveQuote;
    return { bid: Number(bid), ask: Number(ask), mid: Number(mid) };
  }

  // Last known price, kept without expiry. Only a reference (validating SL/TP
  // levels while the market is closed), never a price to trade at.
  async getLastQuote(pair: string): Promise<LiveQuote> {
    try {
      return await this.getQuote(pair);
    } catch (err) {
      if (!(err instanceof PriceUnavailableError)) throw err;
    }
    const raw = await this.redis.get(`price:last:${pair.replace('/', '_')}`);
    if (!raw) throw new PriceUnavailableError(`No price has been seen for ${pair} yet`);
    const { bid, ask, mid } = JSON.parse(raw) as LiveQuote;
    return { bid: Number(bid), ask: Number(ask), mid: Number(mid) };
  }

  // `streamMids` (pair -> mid, EUR/USD format) are prices seen in the same tick
  // batch. The tick consumer passes them so a cross pair converts at the rate of
  // that moment in the feed (also while catching up a backlog), and so a missing
  // Redis key right after a restart doesn't block it. Redis is the fallback.
  async quoteToUsd(pair: string, price: number, streamMids?: ReadonlyMap<string, number>): Promise<number> {
    const [base, quote] = pair.split('/');
    if (quote === 'USD' || base === 'USD') return quoteToUsdRate(pair, price);
    return quoteToUsdRate(pair, price, await this.crossRateToUsd(quote, streamMids));
  }

  async valuePosition(pair: string, lots: number, price: number, leverage: number): Promise<PositionValuation> {
    const spec = await this.getSpec(pair);
    const quoteToUsd = await this.quoteToUsd(pair, price);
    return {
      units: positionUnits(lots, spec),
      marginRequired: marginRequiredUsd(lots, spec, price, quoteToUsd, leverage),
      pipValue: pipValueUsd(lots, spec, quoteToUsd),
      quoteToUsd,
    };
  }

  // currency->USD from the live CUR/USD pair, or the inverse of USD/CUR.
  private async crossRateToUsd(currency: string, streamMids?: ReadonlyMap<string, number>): Promise<number> {
    const direct = streamMids?.get(`${currency}/USD`);
    if (direct) return direct;
    const inverse = streamMids?.get(`USD/${currency}`);
    if (inverse) return 1 / inverse;
    try {
      return (await this.getQuote(`${currency}/USD`)).mid;
    } catch (err) {
      if (!(err instanceof PriceUnavailableError)) throw err;
      return 1 / (await this.getQuote(`USD/${currency}`)).mid;
    }
  }
}
