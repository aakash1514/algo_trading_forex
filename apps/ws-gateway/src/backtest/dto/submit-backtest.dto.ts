import {
  IsString,
  IsIn,
  IsDateString,
  IsOptional,
  IsObject,
  IsNumber,
} from 'class-validator';

export class SubmitBacktestDto {
  @IsString()
  instrument!: string; // e.g. 'EUR_USD'

  @IsIn(['1m', '5m', '15m', '1h', '4h', '1d'])
  timeframe!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsIn(['ma_crossover', 'london_breakout'])
  strategyName!: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, number>;

  @IsOptional()
  @IsNumber()
  lots?: number;
}