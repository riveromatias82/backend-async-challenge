import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import { NonRetryableMessageError, RabbitMqService } from '../common/rabbitmq/rabbitmq.service';
import { InventoryService } from '../inventory/inventory.service';

interface OrderCreatedEvent {
  payload: { orderId: string; items: Array<{ sku: string; quantity: number }> };
}

interface OrderCancelledEvent {
  payload: { orderId: string };
}

@Injectable()
export class InventoryEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(InventoryEventsConsumer.name);

  constructor(
    private readonly rabbitMqService: RabbitMqService,
    private readonly inventoryService: InventoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rabbitMqService.subscribe(
      'inventory-service.orders',
      ['orders.created', 'orders.cancelled'],
      async (message: ConsumeMessage) => {
        const routingKey = message.fields.routingKey;

        if (routingKey === 'orders.created') {
          const event = this.rabbitMqService.parseMessage<OrderCreatedEvent>(message);
          this.assertValidOrderCreated(event);
          await this.inventoryService.handleOrderCreated(event);
          this.logger.log(`Processed orders.created for ${event.payload.orderId}`);
          return;
        }

        if (routingKey === 'orders.cancelled') {
          const event = this.rabbitMqService.parseMessage<OrderCancelledEvent>(message);
          this.assertValidOrderCancelled(event);
          await this.inventoryService.handleOrderCancelled(event);
          this.logger.log(`Processed orders.cancelled for ${event.payload.orderId}`);
        }
      },
    );
  }

  private assertValidOrderCreated(event: OrderCreatedEvent): void {
    if (!event?.payload?.orderId || !Array.isArray(event.payload.items)) {
      throw new NonRetryableMessageError('Invalid OrderCreated event payload');
    }

    for (const item of event.payload.items) {
      if (!item?.sku || typeof item.sku !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new NonRetryableMessageError('Invalid OrderCreated item payload');
      }
    }
  }

  private assertValidOrderCancelled(event: OrderCancelledEvent): void {
    if (!event?.payload?.orderId || typeof event.payload.orderId !== 'string') {
      throw new NonRetryableMessageError('Invalid OrderCancelled event payload');
    }
  }
}
