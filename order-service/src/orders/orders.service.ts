import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RabbitMqService } from '../common/rabbitmq/rabbitmq.service';
import { CreateOrderDto } from './dto';
import { Order, OrderDocument } from './order.schema';
import { randomUUID } from 'crypto';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly rabbitMqService: RabbitMqService,
  ) {}

  async createOrder(dto: CreateOrderDto): Promise<OrderDocument> {
    const order = await this.orderModel.create({
      customerId: dto.customerId,
      items: dto.items,
      status: 'PENDING',
    });

    await this.rabbitMqService.publish('orders.created', {
      eventId: randomUUID(),
      eventType: 'OrderCreated',
      occurredAt: new Date().toISOString(),
      payload: {
        orderId: order.id,
        customerId: order.customerId,
        items: order.items,
      },
    });

    return order;
  }

  async getOrder(id: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async cancelOrder(id: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException('Order not found');

    // Avoid reprocessing an order that is already cancelled.
    if (order.status === 'CANCELLED') return order;
    if (order.status !== 'PENDING') {
      throw new ConflictException(`Order cannot be cancelled from status ${order.status}`);
    }

    order.status = 'CANCELLED';
    await order.save();

    await this.rabbitMqService.publish('orders.cancelled', {
      eventId: randomUUID(),
      eventType: 'OrderCancelled',
      occurredAt: new Date().toISOString(),
      payload: { orderId: order.id },
    });

    return order;
  }

  async markConfirmed(orderId: string): Promise<void> {
    await this.orderModel
      .updateOne({ _id: orderId, status: 'PENDING' }, { $set: { status: 'CONFIRMED' }, $unset: { rejectionReason: 1 } })
      .exec();
  }

  async markRejected(orderId: string, reason: string): Promise<void> {
    await this.orderModel
      .updateOne({ _id: orderId, status: 'PENDING' }, { $set: { status: 'REJECTED', rejectionReason: reason } })
      .exec();
  }
}
