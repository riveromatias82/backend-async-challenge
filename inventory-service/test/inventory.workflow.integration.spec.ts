import { InventoryService } from '../src/inventory/inventory.service';

type StockState = { availableQuantity: number; reservedQuantity: number };
type ReservationState = {
  orderId: string;
  status: 'RESERVED' | 'RELEASED' | 'FAILED';
  items: Array<{ sku: string; quantity: number }>;
  failureReason?: string;
};

class InMemoryStockModel {
  private readonly stock = new Map<string, StockState>();

  db = {
    startSession: async () => ({
      withTransaction: async (callback: () => Promise<void>) => callback(),
      endSession: async () => undefined,
    }),
  };

  seed(sku: string, availableQuantity: number): void {
    this.stock.set(sku, { availableQuantity, reservedQuantity: 0 });
  }

  getStock(sku: string): StockState | undefined {
    return this.stock.get(sku);
  }

  updateOne(
    filter: { sku: string; availableQuantity?: { $gte: number }; reservedQuantity?: { $gte: number } },
    update: { $inc: { availableQuantity: number; reservedQuantity: number } },
  ): { exec: () => Promise<{ modifiedCount: number }> } {
    return {
      exec: async () => {
        const current = this.stock.get(filter.sku);
        if (!current) return { modifiedCount: 0 };

        if (filter.availableQuantity && current.availableQuantity < filter.availableQuantity.$gte) {
          return { modifiedCount: 0 };
        }
        if (filter.reservedQuantity && current.reservedQuantity < filter.reservedQuantity.$gte) {
          return { modifiedCount: 0 };
        }

        current.availableQuantity += update.$inc.availableQuantity;
        current.reservedQuantity += update.$inc.reservedQuantity;
        return { modifiedCount: 1 };
      },
    };
  }
}

class InMemoryReservationModel {
  private readonly reservations = new Map<string, ReservationState>();

  get(orderId: string): ReservationState | undefined {
    return this.reservations.get(orderId);
  }

  findOne(filter: { orderId: string }): {
    session: () => { exec: () => Promise<ReservationState | null> };
    exec: () => Promise<ReservationState | null>;
  } {
    const read = async () => this.reservations.get(filter.orderId) ?? null;
    return {
      session: () => ({ exec: read }),
      exec: read,
    };
  }

  async create(docs: ReservationState[]): Promise<ReservationState[]> {
    const [doc] = docs;
    if (this.reservations.has(doc.orderId)) {
      const duplicateError = Object.assign(new Error('Duplicate key'), { code: 11000 });
      throw duplicateError;
    }
    this.reservations.set(doc.orderId, { ...doc });
    return docs;
  }

  async findOneAndUpdate(
    filter: { orderId: string },
    update: { $setOnInsert: ReservationState },
    options: { upsert: boolean },
  ): Promise<ReservationState | null> {
    if (!this.reservations.has(filter.orderId) && options.upsert) {
      this.reservations.set(filter.orderId, { ...update.$setOnInsert });
    }
    return this.reservations.get(filter.orderId) ?? null;
  }

  updateOne(
    filter: { orderId: string; status?: 'RESERVED' },
    update: { $set?: { status: 'RELEASED' }; $setOnInsert?: ReservationState; $unset?: { failureReason: 1 } },
    options?: { upsert?: boolean },
  ): { exec: () => Promise<{ modifiedCount: number }> } {
    return {
      exec: async () => {
        const current = this.reservations.get(filter.orderId);
        if (!current) {
          if (options?.upsert && update.$setOnInsert) {
            this.reservations.set(filter.orderId, { ...update.$setOnInsert });
            return { modifiedCount: 1 };
          }
          return { modifiedCount: 0 };
        }

        if (filter.status && current.status !== filter.status) return { modifiedCount: 0 };

        if (update.$set) current.status = update.$set.status;
        if (update.$unset?.failureReason) delete current.failureReason;
        return { modifiedCount: 1 };
      },
    };
  }
}

describe('Inventory reservation workflow (integration without Mongo)', () => {
  const publish = jest.fn();

  const createService = () => {
    const stockModel = new InMemoryStockModel();
    const reservationModel = new InMemoryReservationModel();
    const service = new InventoryService(
      stockModel as never,
      reservationModel as never,
      { publish } as never,
    );
    return { service, stockModel, reservationModel };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('happy path: reserves stock and emits inventory.reserved', async () => {
    const { service, stockModel, reservationModel } = createService();
    stockModel.seed('SKU-1', 10);

    await service.handleOrderCreated({
      payload: { orderId: 'order-happy', items: [{ sku: 'SKU-1', quantity: 2 }] },
    });

    expect(reservationModel.get('order-happy')?.status).toBe('RESERVED');
    expect(stockModel.getStock('SKU-1')).toEqual({ availableQuantity: 8, reservedQuantity: 2 });
    expect(publish).toHaveBeenCalledWith(
      'inventory.reserved',
      expect.objectContaining({ payload: { orderId: 'order-happy' } }),
    );
  });

  it('insufficient stock path: stores FAILED reservation and emits inventory.rejected', async () => {
    const { service, stockModel, reservationModel } = createService();
    stockModel.seed('SKU-LOW', 1);

    await service.handleOrderCreated({
      payload: { orderId: 'order-low-stock', items: [{ sku: 'SKU-LOW', quantity: 3 }] },
    });

    expect(reservationModel.get('order-low-stock')?.status).toBe('FAILED');
    expect(stockModel.getStock('SKU-LOW')).toEqual({ availableQuantity: 1, reservedQuantity: 0 });
    expect(publish).toHaveBeenCalledWith(
      'inventory.rejected',
      expect.objectContaining({
        payload: { orderId: 'order-low-stock', reason: 'INSUFFICIENT_STOCK' },
      }),
    );
  });

  it('cancellation idempotency: releasing twice does not double-increment stock', async () => {
    const { service, stockModel, reservationModel } = createService();
    stockModel.seed('SKU-CAN', 5);

    await service.handleOrderCreated({
      payload: { orderId: 'order-cancel', items: [{ sku: 'SKU-CAN', quantity: 2 }] },
    });

    await service.handleOrderCancelled({ payload: { orderId: 'order-cancel' } });
    await service.handleOrderCancelled({ payload: { orderId: 'order-cancel' } });

    expect(reservationModel.get('order-cancel')?.status).toBe('RELEASED');
    expect(stockModel.getStock('SKU-CAN')).toEqual({ availableQuantity: 5, reservedQuantity: 0 });
  });

  it('cancel-before-create: stores RELEASED tombstone and ignores later create', async () => {
    const { service, stockModel, reservationModel } = createService();
    stockModel.seed('SKU-LATE', 5);

    await service.handleOrderCancelled({ payload: { orderId: 'order-late' } });
    await service.handleOrderCreated({
      payload: { orderId: 'order-late', items: [{ sku: 'SKU-LATE', quantity: 2 }] },
    });

    expect(reservationModel.get('order-late')?.status).toBe('RELEASED');
    expect(stockModel.getStock('SKU-LATE')).toEqual({ availableQuantity: 5, reservedQuantity: 0 });
    expect(publish).not.toHaveBeenCalledWith(
      'inventory.reserved',
      expect.objectContaining({ payload: { orderId: 'order-late' } }),
    );
  });
});
