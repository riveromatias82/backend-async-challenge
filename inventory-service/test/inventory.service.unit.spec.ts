import { InventoryService } from '../src/inventory/inventory.service';

type Item = { sku: string; quantity: number };

describe('InventoryService (unit)', () => {
  const publish = jest.fn();
  const findOne = jest.fn();
  const findOneAndUpdate = jest.fn();
  const create = jest.fn();
  const updateOne = jest.fn();
  const reservationUpdateOne = jest.fn();

  const session = {
    withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };

  const stockModel = {
    db: { startSession: jest.fn().mockResolvedValue(session) },
    updateOne,
    findOne: jest.fn(),
  };

  const reservationModel = {
    findOne,
    findOneAndUpdate,
    create,
    updateOne: reservationUpdateOne,
  };

  const rabbitMqService = { publish };

  const eventFor = (items: Item[]) => ({ payload: { orderId: 'order-1', items } });

  let service: InventoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InventoryService(stockModel as never, reservationModel as never, rabbitMqService as never);
  });

  it('publishes inventory.reserved for a successful reservation', async () => {
    findOne.mockReturnValue({ session: () => ({ exec: jest.fn().mockResolvedValue(null) }) });
    updateOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) });
    create.mockResolvedValue([{ orderId: 'order-1' }]);

    await service.handleOrderCreated(eventFor([{ sku: 'A', quantity: 2 }]));

    expect(create).toHaveBeenCalledWith(
      [expect.objectContaining({ orderId: 'order-1', status: 'RESERVED' })],
      expect.objectContaining({ session }),
    );
    expect(publish).toHaveBeenCalledWith(
      'inventory.reserved',
      expect.objectContaining({ eventType: 'InventoryReserved', payload: { orderId: 'order-1' } }),
    );
  });

  it('publishes inventory.rejected for insufficient stock', async () => {
    findOne.mockReturnValue({ session: () => ({ exec: jest.fn().mockResolvedValue(null) }) });
    updateOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) });
    findOneAndUpdate.mockResolvedValue({ orderId: 'order-1', status: 'FAILED' });

    await service.handleOrderCreated(eventFor([{ sku: 'A', quantity: 999 }]));

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { orderId: 'order-1' },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ status: 'FAILED' }),
      }),
      { upsert: true },
    );
    expect(publish).toHaveBeenCalledWith(
      'inventory.rejected',
      expect.objectContaining({
        eventType: 'InventoryRejected',
        payload: { orderId: 'order-1', reason: 'INSUFFICIENT_STOCK' },
      }),
    );
  });

  it('replays reserved outcome on duplicate OrderCreated', async () => {
    findOne.mockReturnValue({
      session: () => ({
        exec: jest.fn().mockResolvedValue({ orderId: 'order-1', status: 'RESERVED', items: [{ sku: 'A', quantity: 1 }] }),
      }),
    });

    await service.handleOrderCreated(eventFor([{ sku: 'A', quantity: 1 }]));

    expect(updateOne).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      'inventory.reserved',
      expect.objectContaining({ payload: { orderId: 'order-1' } }),
    );
  });

  it('releases stock exactly once for OrderCancelled', async () => {
    let status: 'RESERVED' | 'RELEASED' = 'RESERVED';
    findOne.mockReturnValue({
      session: () => ({
        exec: jest.fn(async () => ({ orderId: 'order-1', status, items: [{ sku: 'A', quantity: 2 }] })),
      }),
    });
    updateOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) });
    reservationUpdateOne.mockReturnValue({
      exec: jest.fn(async () => {
        status = 'RELEASED';
        return { modifiedCount: 1 };
      }),
    });

    await service.handleOrderCancelled({ payload: { orderId: 'order-1' } });
    await service.handleOrderCancelled({ payload: { orderId: 'order-1' } });

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(reservationUpdateOne).toHaveBeenCalledTimes(1);
  });
});
