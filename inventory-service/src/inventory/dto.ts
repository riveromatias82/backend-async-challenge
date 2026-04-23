import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class UpsertStockDto {
  @IsString()
  @IsNotEmpty()
  sku!: string;

  @IsInt()
  @Min(0)
  available!: number;
}
