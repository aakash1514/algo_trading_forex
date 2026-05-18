import { IsIn, IsISO8601, IsOptional, IsPositive, Max } from 'class-validator';
import { Transform } from 'class-transformer';

export const VALID_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof VALID_TIMEFRAMES)[number];

// Maps our timeframe string to the TimescaleDB view name
export const TIMEFRAME_VIEW_MAP: Record<Timeframe, string> = {
  '1m':  'candles_1m',
  '5m':  'candles_5m',
  '15m': 'candles_15m',
  '1h':  'candles_1h',
  '4h':  'candles_4h',
  '1d':  'candles_1d',
};

export class CandleQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsPositive()
  @Max(5000)
  limit?: number = 500;
}