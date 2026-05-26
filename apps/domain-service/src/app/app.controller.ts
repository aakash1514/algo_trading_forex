import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  ParseFloatPipe,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import { PipCalculatorService } from '../pip-calculator/pip-calculator.service';
import { SessionClockService } from '../session-clock/session-clock.service';
import { SpreadMonitorService } from '../spread-monitor/spread-monitor.service';
import { SwapCalculationService } from '../swap-calculation/swap-calculation.service';
import { MarginEngineService } from '../margin-engine/margin-engine.service';
import { EconomicCalendarService, ImpactLevel } from '../economic-calendar/economic-calendar.service';

class MarginCalculateDto {
  pair!: string;
  lots!: number;
  leverage!: number;
  currentPrice!: number;
}

@Controller('domain')
export class AppController {
  constructor(
    private readonly pipCalculator: PipCalculatorService,
    private readonly sessionClock: SessionClockService,
    private readonly spreadMonitor: SpreadMonitorService,
    private readonly swapCalculation: SwapCalculationService,
    private readonly marginEngine: MarginEngineService,
    private readonly economicCalendar: EconomicCalendarService,
  ) {}

  // GET /api/domain/pip-value/EUR_USD/1/USD
  @Get('pip-value/:pair/:lots/:accountCurrency')
  async getPipValue(
    @Param('pair') pairRaw: string,
    @Param('lots', ParseFloatPipe) lots: number,
    @Param('accountCurrency') accountCurrency: string,
  ) {
    // Accept both EUR_USD and EUR/USD formats
    const pair = pairRaw.replace('_', '/');
    return this.pipCalculator.calculatePipValue(pair, lots, accountCurrency);
  }

  // GET /api/domain/sessions/current
  @Get('sessions/current')
  getCurrentSessions() {
    return this.sessionClock.getCurrentSessions();
  }

  // GET /api/domain/swaps/EUR_USD
  @Get('swaps/:pair')
  async getSwapRate(@Param('pair') pairRaw: string) {
    const pair = pairRaw.replace('_', '/');
    const rate = await this.swapCalculation.getSwapRate(pair);
    if (!rate) throw new NotFoundException(`No swap rate found for ${pair}. Run the daily cron first.`);
    return rate;
  }

  // GET /api/domain/spread/EUR_USD
  @Get('spread/:pair')
  getSpreadStatus(@Param('pair') instrument: string) {
    // instrument format: EUR_USD
    const status = this.spreadMonitor.getSpreadStatus(instrument);
    if (!status) throw new NotFoundException(`No spread data for ${instrument}. Is market-service running?`);
    return status;
  }

  // GET /api/domain/calendar?currency=USD&impact=HIGH&from=2026-05-15
  @Get('calendar')
  async getCalendar(
    @Query('currency') currency?: string,
    @Query('impact') impact?: ImpactLevel,
    @Query('from') from?: string,
  ) {
    const fromDate = from ? new Date(from) : undefined;
    return this.economicCalendar.getUpcomingEvents(currency, fromDate, impact);
  }

  // POST /api/domain/margin/calculate
  @Post('margin/calculate')
  calculateMargin(@Body() body: MarginCalculateDto) {
    return this.marginEngine.calculateMarginRequired(
      body.pair,
      body.lots,
      body.leverage,
      body.currentPrice,
    );
  }
}