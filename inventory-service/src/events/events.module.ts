import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryEventsConsumer } from './inventory-events.consumer';

@Module({
  imports: [InventoryModule],
  providers: [InventoryEventsConsumer],
})
export class EventsModule {}
