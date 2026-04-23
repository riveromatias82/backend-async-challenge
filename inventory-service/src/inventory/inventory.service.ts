import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { RabbitMqService } from '../common/rabbitmq/rabbitmq.service';
import { UpsertStockDto } from './dto';
import { Reservation, ReservationDocument } from './reservation.schema';
import { StockItem, StockItemDocument } from './stock.schema';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  private static readonly INSUFFICIENT_STOCK = 'INSUFFICIENT_STOCK';
  private static readonly ORDER_ALREADY_RELEASED = 'ORDER_ALREADY_RELEASED';

  constructor(
    @InjectModel(StockItem.name) private readonly stockModel: Model<StockItemDocument>,
    @InjectModel(Reservation.name) private readonly reservationModel: Model<ReservationDocument>,
    private readonly rabbitMqService: RabbitMqService,
  ) {}

  async upsertStock(dto: UpsertStockDto): Promise<StockItemDocument> {
    return this.stockModel
      .findOneAndUpdate(
        { sku: dto.sku },
        { $set: { sku: dto.sku, availableQuantity: dto.available } },
        { upsert: true, new: true },
      )
      .exec();
  }

  async getStock(sku: string): Promise<StockItemDocument> {
    const stock = await this.stockModel.findOne({ sku }).exec();
    if (!stock) throw new NotFoundException('SKU not found');
    return stock;
  }

  async handleOrderCreated(event: { payload: { orderId: string; items: Array<{ sku: string; quantity: number }> } }): Promise<void> {
    const { orderId, items } = event.payload;
    const session = await this.stockModel.db.startSession();
    let reservationOutcome: 'RESERVED' | 'FAILED' | 'IGNORED' = 'FAILED';
    let rejectionReason = InventoryService.INSUFFICIENT_STOCK;

    try {
      await session.withTransaction(async () => {
        // Idempotency guard: if we already processed this order, replay the prior outcome.
        const existingReservation = await this.reservationModel.findOne({ orderId }).session(session).exec();
        if (existingReservation) {
          if (existingReservation.status === 'FAILED') {
            reservationOutcome = 'FAILED';
            rejectionReason = existingReservation.failureReason ?? InventoryService.INSUFFICIENT_STOCK;
          } else if (existingReservation.status === 'RELEASED') {
            reservationOutcome = 'IGNORED';
            rejectionReason = InventoryService.ORDER_ALREADY_RELEASED;
          } else {
            reservationOutcome = 'RESERVED';
          }
          return;
        }

        for (const item of items) {
          // Atomic reservation per SKU; fails if available stock is insufficient.
          const updated = await this.stockModel
            .updateOne(
              { sku: item.sku, availableQuantity: { $gte: item.quantity } },
              { $inc: { availableQuantity: -item.quantity, reservedQuantity: item.quantity } },
              { session },
            )
            .exec();

          if (updated.modifiedCount !== 1) {
            throw new Error(InventoryService.INSUFFICIENT_STOCK);
          }
        }

        await this.reservationModel.create(
          [
            {
              orderId,
              status: 'RESERVED',
              items,
            },
          ],
          { session },
        );
        reservationOutcome = 'RESERVED';
      });
    } catch (error) {
      if (error instanceof Error && error.message === InventoryService.INSUFFICIENT_STOCK) {
        reservationOutcome = 'FAILED';
      } else
      if (this.isDuplicateKeyError(error)) {
        // Concurrent consumers may race on insert; read back final persisted outcome.
        const existingReservation = await this.reservationModel.findOne({ orderId }).exec();
        if (existingReservation) {
          if (existingReservation.status === 'FAILED') {
            reservationOutcome = 'FAILED';
            rejectionReason = existingReservation.failureReason ?? InventoryService.INSUFFICIENT_STOCK;
          } else if (existingReservation.status === 'RELEASED') {
            reservationOutcome = 'IGNORED';
            rejectionReason = InventoryService.ORDER_ALREADY_RELEASED;
          } else {
            reservationOutcome = 'RESERVED';
          }
        }
      } else {
        throw error;
      }
    } finally {
      await session.endSession();
    }

    if (reservationOutcome === 'RESERVED') {
      await this.publishReserved(orderId);
      this.logger.log(`Inventory reserved for order ${orderId}`);
      return;
    }
    if (reservationOutcome === 'IGNORED') {
      this.logger.warn(`Ignoring duplicate order.created for already released order ${orderId}`);
      return;
    }

    await this.reservationModel.findOneAndUpdate(
      { orderId },
      {
        $setOnInsert: {
          orderId,
          status: 'FAILED',
          failureReason: rejectionReason,
          items,
        },
      },
      { upsert: true },
    );

    await this.publishRejected(orderId, rejectionReason);
    this.logger.log(`Inventory rejected for order ${orderId}`);
  }

  async handleOrderCancelled(event: { payload: { orderId: string } }): Promise<void> {
    const { orderId } = event.payload;
    const session = await this.stockModel.db.startSession();

    try {
      await session.withTransaction(async () => {
        const reservation = await this.reservationModel.findOne({ orderId }).session(session).exec();
        if (!reservation) {
          // Tombstone prevents late OrderCreated events from reserving stock after cancellation.
          await this.reservationModel
            .updateOne(
              { orderId },
              {
                $setOnInsert: {
                  orderId,
                  status: 'RELEASED',
                  items: [],
                },
              },
              { upsert: true, session },
            )
            .exec();
          return;
        }
        if (reservation.status !== 'RESERVED') return;

        for (const item of reservation.items) {
          const updated = await this.stockModel
            .updateOne(
              { sku: item.sku, reservedQuantity: { $gte: item.quantity } },
              { $inc: { availableQuantity: item.quantity, reservedQuantity: -item.quantity } },
              { session },
            )
            .exec();

          if (updated.modifiedCount !== 1) {
            throw new Error(`Failed to release reservation for SKU ${item.sku}`);
          }
        }

        await this.reservationModel
          .updateOne({ orderId, status: 'RESERVED' }, { $set: { status: 'RELEASED' }, $unset: { failureReason: 1 } }, { session })
          .exec();
      });
    } finally {
      await session.endSession();
    }

    this.logger.log(`Inventory release evaluated for cancelled order ${orderId}`);
  }

  private async publishReserved(orderId: string): Promise<void> {
    await this.rabbitMqService.publish('inventory.reserved', {
      eventId: randomUUID(),
      eventType: 'InventoryReserved',
      occurredAt: new Date().toISOString(),
      payload: { orderId },
    });
  }

  private async publishRejected(orderId: string, reason: string): Promise<void> {
    await this.rabbitMqService.publish('inventory.rejected', {
      eventId: randomUUID(),
      eventType: 'InventoryRejected',
      occurredAt: new Date().toISOString(),
      payload: { orderId, reason },
    });
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000;
  }
}
