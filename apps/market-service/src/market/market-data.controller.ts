import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
} from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { CandleQueryDto, VALID_TIMEFRAMES, Timeframe } from './dto/candle-query.dto';

@Controller('market')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(private readonly marketDataService: MarketDataService) {}

  // GET /api/market/price/EUR_USD
  // Returns latest bid/ask/mid from Redis cache
  @Get('price/:pair')
  async getPrice(@Param('pair') pair: string) {
    return this.marketDataService.getLatestPrice(pair);
  }

  // GET /api/market/candles/EUR_USD/1h
  // GET /api/market/candles/EUR_USD/1h?from=2024-01-01&to=2024-01-31&limit=200
  @Get('candles/:pair/:timeframe')
  async getCandles(
    @Param('pair') pair: string,
    @Param('timeframe') timeframe: string,
    @Query() query: CandleQueryDto,
  ) {
    // Validate timeframe manually so we can return a clean error
    if (!VALID_TIMEFRAMES.includes(timeframe as Timeframe)) {
      return {
        error: `Invalid timeframe. Valid options: ${VALID_TIMEFRAMES.join(', ')}`,
      };
    }

    return this.marketDataService.getCandles(pair, timeframe as Timeframe, query);
  }
}