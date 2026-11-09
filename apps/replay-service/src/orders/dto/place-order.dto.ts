import { IsIn, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';

// A market order: fills at the next processed minute's open (BUY at the ask, SELL at
// the bid). SL/TP are prices at the pair's scale (EUR/USD 5 decimals, USD/JPY and
// XAU/USD 3); the service checks they are whole points on the right side.
export class PlaceOrderDto {
  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  // units = lots x instruments.lot_size (must be whole)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  lots!: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  stopLoss?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  takeProfit?: number;
}
