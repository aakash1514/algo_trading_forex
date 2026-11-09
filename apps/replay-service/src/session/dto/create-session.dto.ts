import { buildMessage, IsIn, IsNumber, IsOptional, Max, Min, ValidateBy, ValidationOptions } from 'class-validator';
import { parseStartTime, REPLAY_INSTRUMENTS, REPLAY_TIMEFRAMES } from '../replay-window';

function IsReplayStart(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'isReplayStart',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string') return false;
        try {
          parseStartTime(value);
          return true;
        } catch {
          return false;
        }
      },
      defaultMessage: buildMessage(
        (prefix) => `${prefix}$property must be a whole UTC minute between 2010-01-01T00:00Z and 2022-12-30T23:59Z`, options),
    },
  }, options);
}

export class CreateSessionDto {
  @IsIn(REPLAY_INSTRUMENTS)
  instrument!: string; // 'EUR_USD'

  // The clock starts at the first traded minute at or after it
  @IsReplayStart()
  startTime!: string;

  // USD; default 10,000
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(100)
  @Max(10_000_000)
  startingBalance?: number;

  @IsIn(REPLAY_TIMEFRAMES)
  timeframe!: string;
}
