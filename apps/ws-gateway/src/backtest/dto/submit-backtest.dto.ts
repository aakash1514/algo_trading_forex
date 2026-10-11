import {
  IsString,
  IsIn,
  IsOptional,
  IsObject,
  IsNumber,
  ValidateBy,
  ValidationOptions,
  buildMessage,
} from 'class-validator';
import { parseDay } from '../backtest-window';

// A calendar day 'YYYY-MM-DD' (UTC). Timestamps and impossible dates are rejected.
function IsCalendarDay(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'isCalendarDay',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string') return false;
        try {
          parseDay(value);
          return true;
        } catch {
          return false;
        }
      },
      defaultMessage: buildMessage((prefix) => `${prefix}$property must be a calendar date (YYYY-MM-DD)`, options),
    },
  }, options);
}

export class SubmitBacktestDto {
  @IsString()
  instrument!: string; // e.g. 'EUR_USD'

  @IsIn(['1m', '5m', '15m', '1h', '4h', '1d'])
  timeframe!: string;

  // Both days inclusive, UTC: To = 2022-12-30 runs through 2022-12-30 23:59
  @IsCalendarDay()
  fromDate!: string;

  @IsCalendarDay()
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
