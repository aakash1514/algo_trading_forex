import { IsIn, IsNumber, IsOptional, IsPositive, Matches, Max, Min } from 'class-validator';
import type { OrderDirection, OrderType } from '@forexedge/database';
import { INSTRUMENT_PATTERN } from '../../common/instrument';

export const ORDER_DIRECTIONS: readonly OrderDirection[] = ['LONG', 'SHORT'];
export const ORDER_TYPES: readonly OrderType[] = ['MARKET', 'LIMIT', 'STOP', 'TRAILING_STOP', 'OCO'];

// Request body for POST /api/orders. `pair` is not part of the contract:
// it is derived server-side from `instrument` (see OrderRequest).
export class SubmitOrderDto {
  @Matches(INSTRUMENT_PATTERN, { message: 'instrument must look like EUR_USD' })
  instrument!: string;

  @IsIn(ORDER_DIRECTIONS)
  direction!: OrderDirection;

  @IsIn(ORDER_TYPES)
  orderType!: OrderType;

  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  lots!: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  requestedPrice?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  stopLoss?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  takeProfit?: number;
}

// Validated request plus server-derived fields, used past the controller.
export interface OrderRequest extends SubmitOrderDto {
  pair: string;
}
