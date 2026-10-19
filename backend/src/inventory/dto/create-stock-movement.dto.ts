import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateStockMovementDto {
  @IsIn(['RESTOCK', 'ADJUSTMENT', 'DAMAGE'])
  type!: 'RESTOCK' | 'ADJUSTMENT' | 'DAMAGE';

  @Type(() => Number)
  @IsInt()
  @Min(-2147483647)
  @Max(2147483647)
  delta!: number;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() || undefined : value)
  @IsString()
  @MaxLength(500)
  note?: string;
}
