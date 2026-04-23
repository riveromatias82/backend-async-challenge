import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { OrderEventsConsumer } from './order-events.consumer';

@Module({
  imports: [OrdersModule],
  providers: [OrderEventsConsumer],
})
export class EventsModule {}
