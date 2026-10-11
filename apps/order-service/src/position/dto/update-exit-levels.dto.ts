import { IsNumber, IsOptional, IsPositive, ValidateIf } from 'class-validator';

// Body of PATCH /api/positions/:id. Per field: a number sets the level, null
// clears it, leaving the field out keeps the current level. At least one field
// is required (checked in PositionService). Same number rules as order placement.
export class UpdateExitLevelsDto {
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  stopLoss?: number | null;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  takeProfit?: number | null;
}
