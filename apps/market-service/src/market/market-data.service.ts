import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectRedis } from '../redis/redis.decorator';
import Redis from 'ioredis';
import { CandleQueryDto, Timeframe, TIMEFRAME_VIEW_MAP } from './dto/candle-query.dto';
import { NormalizedTick } from '@forexedge/kafka';

export interface CandleRow {
  bucket: Date;
  instrument: string;
  pair: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_count: number;
  avg_spread: number;
}

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ----------------------------------------------------------------
  // GET /api/market/price/:pair
  // ----------------------------------------------------------------
  // Reads from Redis — sub-millisecond response
  // Redis key: price:EUR_USD → JSON string of NormalizedTick
  // ----------------------------------------------------------------
  async getLatestPrice(pair: string): Promise<NormalizedTick> {
    const instrument = pair.replace('/', '_').toUpperCase();
    const cached = await this.redis.get(`price:${instrument}`);

    if (!cached) {
      throw new NotFoundException(
        `No price available for ${pair}. Market data may still be warming up.`,
      );
    }

    return JSON.parse(cached) as NormalizedTick;
  }

  // ----------------------------------------------------------------
  // GET /api/market/candles/:pair/:timeframe
  // ----------------------------------------------------------------
  // Reads from continuous aggregate views — pre-computed, very fast
  // ----------------------------------------------------------------
  async getCandles(
    pair: string,
    timeframe: Timeframe,
    query: CandleQueryDto,
  ): Promise<CandleRow[]> {
    const instrument = pair.replace('/', '_').toUpperCase();
    const view = TIMEFRAME_VIEW_MAP[timeframe];

    // Build query dynamically based on optional from/to/limit params
    const conditions: string[] = ['instrument = $1'];
    const params: unknown[] = [instrument];
    let paramIndex = 2;

    if (query.from) {
      conditions.push(`bucket >= $${paramIndex++}`);
      params.push(new Date(query.from));
    }

    if (query.to) {
      conditions.push(`bucket <= $${paramIndex++}`);
      params.push(new Date(query.to));
    }

    const whereClause = conditions.join(' AND ');
    const limit = query.limit ?? 500;

    const sql = `
      SELECT
        bucket, instrument, pair,
        open, high, low, close,
        tick_count, avg_spread
      FROM ${view}
      WHERE ${whereClause}
      ORDER BY bucket DESC
      LIMIT $${paramIndex}
    `;

    params.push(limit);

    const rows = await this.dataSource.query<CandleRow[]>(sql, params);

    if (rows.length === 0) {
      this.logger.debug(`No candles found for ${instrument} on ${timeframe}`);
    }

    // Return in ascending time order (oldest first) — standard for charts
    return rows.reverse();
  }
}