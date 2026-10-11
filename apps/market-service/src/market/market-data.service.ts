import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectRedis } from '../redis/redis.decorator';
import Redis from 'ioredis';
import { CandleQueryDto, Timeframe, TIMEFRAME_VIEW_MAP } from './dto/candle-query.dto';
import { NormalizedTick } from '@forexedge/kafka';
import { HistoricalDataError, pointsToPrice, readHistoricalBars, requireHistoricalCoverage } from '@forexedge/database';

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

// Historical rows keep the live shape for charts: mid OHLC (open/close exact
// (bid + ask) / 2; high/low the mean of the bid and ask extremes), plus the M1
// bars in the bucket and the close spread in pips.
export interface HistoricalCandleRow {
  bucket: Date;
  instrument: string;
  pair: string;
  open: number;
  high: number;
  low: number;
  close: number;
  minutes: number;
  spread: number;
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
  ): Promise<CandleRow[] | HistoricalCandleRow[]> {
    if (query.source === 'historical') return this.getHistoricalCandles(pair, timeframe, query);
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

  // ?source=historical: the imported history, checked against historical_coverage
  // (no data for the pair: 404; window outside the covered range: 422).
  async getHistoricalCandles(pair: string, timeframe: Timeframe, query: CandleQueryDto): Promise<HistoricalCandleRow[]> {
    const instrument = pair.replace('/', '_').toUpperCase();
    const dbPair = instrument.replace('_', '/');
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    try {
      const coverage = await requireHistoricalCoverage(this.dataSource, dbPair, from, to);
      const bars = await readHistoricalBars(this.dataSource, { pair: dbPair, timeframe, from, to, limit: query.limit ?? 500 });
      const price = (points: number) => pointsToPrice(points, coverage.priceDecimals);
      // One pip is 10 points at every pair's scale (price_decimals = pip decimals + 1)
      return bars.map((b) => ({
        bucket: b.bucket, instrument, pair: dbPair,
        open: price((b.bidOpen + b.askOpen) / 2),
        high: price((b.bidHigh + b.askHigh) / 2),
        low: price((b.bidLow + b.askLow) / 2),
        close: price((b.bidClose + b.askClose) / 2),
        minutes: b.minutes,
        spread: (b.askClose - b.bidClose) / 10,
      }));
    } catch (err) {
      if (err instanceof HistoricalDataError) {
        throw err.kind === 'no_coverage' ? new NotFoundException(err.message) : new UnprocessableEntityException(err.message);
      }
      throw err;
    }
  }
}