import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UpsertStockDto } from './dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('stock')
  upsert(@Body() body: UpsertStockDto) {
    return this.inventoryService.upsertStock(body);
  }

  @Get(':sku')
  getBySku(@Param('sku') sku: string) {
    return this.inventoryService.getStock(sku);
  }
}
