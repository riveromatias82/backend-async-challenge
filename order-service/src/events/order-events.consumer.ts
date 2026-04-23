import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import { NonRetryableMessageError, RabbitMqService } from '../common/rabbitmq/rabbitmq.service';
import { OrdersService } from '../orders/orders.service';

interface InventoryReservedEvent {
  payload: { orderId: string };
}

interface InventoryRejectedEvent {
  payload: { orderId: string; reason: string };
}

@Injectable()
export class OrderEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsConsumer.name);

  constructor(
    private readonly rabbitMqService: RabbitMqService,
    private readonly ordersService: OrdersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rabbitMqService.subscribe(
      'order-service.inventory-results',
      ['inventory.reserved', 'inventory.rejected'],
      async (message: ConsumeMessage) => {
        const routingKey = message.fields.routingKey;

        if (routingKey === 'inventory.reserved') {
          const event = this.rabbitMqService.parseMessage<InventoryReservedEvent>(message);
          this.assertValidInventoryReserved(event);
          await this.ordersService.markConfirmed(event.payload.orderId);
          this.logger.log(`Order confirmed: ${event.payload.orderId}`);
          return;
        }

        if (routingKey === 'inventory.rejected') {
          const event = this.rabbitMqService.parseMessage<InventoryRejectedEvent>(message);
          this.assertValidInventoryRejected(event);
          await this.ordersService.markRejected(event.payload.orderId, event.payload.reason);
          this.logger.log(`Order rejected: ${event.payload.orderId}`);
        }
      },
    );
  }

  private assertValidInventoryReserved(event: InventoryReservedEvent): void {
    if (!event?.payload?.orderId || typeof event.payload.orderId !== 'string') {
      throw new NonRetryableMessageError('Invalid InventoryReserved event payload');
    }
  }

  private assertValidInventoryRejected(event: InventoryRejectedEvent): void {
    if (!event?.payload?.orderId || typeof event.payload.orderId !== 'string' || !event.payload.reason || typeof event.payload.reason !== 'string') {
      throw new NonRetryableMessageError('Invalid InventoryRejected event payload');
    }
  }
}
