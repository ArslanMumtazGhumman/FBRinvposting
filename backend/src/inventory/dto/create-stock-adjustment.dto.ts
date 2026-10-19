import { Transform, Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { StockMovementType } from '@prisma/client';

export class CreateStockAdjustmentDto {
  @IsIn([
    StockMovementType.PURCHASE,
    StockMovementType.DAMAGE,
    StockMovementType.PURCHASE_RETURN,
    StockMovementType.ADJUSTMENT_IN,
    StockMovementType.ADJUSTMENT_OUT,
  ])
  type!: Exclude<StockMovementType, 'OPENING' | 'SALE' | 'SALE_RETURN'>;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(999999999.999)
  quantity!: number;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() || undefined : value)
  @IsString()
  @MaxLength(500)
  note?: string;
}
