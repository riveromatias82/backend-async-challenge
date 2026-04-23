import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../src/orders/orders.service';

describe('OrdersService (unit)', () => {
  const publish = jest.fn();
  const create = jest.fn();
  const findById = jest.fn();
  const findByIdAndUpdate = jest.fn();
  const updateOne = jest.fn();

  const orderModel = {
    create,
    findById,
    findByIdAndUpdate,
    updateOne,
  };

  const rabbitMqService = {
    publish,
  };

  let service: OrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrdersService(orderModel as never, rabbitMqService as never);
  });

  it('creates order as PENDING and publishes orders.created', async () => {
    create.mockResolvedValue({
      id: 'o-1',
      customerId: 'c-1',
      items: [{ sku: 'SKU-1', quantity: 2 }],
    });

    const result = await service.createOrder({
      customerId: 'c-1',
      items: [{ sku: 'SKU-1', quantity: 2 }],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'c-1',
        status: 'PENDING',
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      'orders.created',
      expect.objectContaining({
        eventType: 'OrderCreated',
        payload: expect.objectContaining({ orderId: 'o-1' }),
      }),
    );
    expect(result.id).toBe('o-1');
  });

  it('throws NotFoundException when getOrder does not exist', async () => {
    findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.getOrder('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publishes orders.cancelled and marks status CANCELLED', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ id: 'o-1', status: 'PENDING', save }),
    });

    await service.cancelOrder('o-1');

    expect(save).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      'orders.cancelled',
      expect.objectContaining({
        eventType: 'OrderCancelled',
        payload: { orderId: 'o-1' },
      }),
    );
  });

  it('is idempotent when cancelling an already cancelled order', async () => {
    const save = jest.fn();
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ id: 'o-1', status: 'CANCELLED', save }),
    });

    const result = await service.cancelOrder('o-1');

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result.status).toBe('CANCELLED');
  });

  it('throws ConflictException when cancelling a non-pending order', async () => {
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ id: 'o-1', status: 'CONFIRMED', save: jest.fn() }),
    });

    await expect(service.cancelOrder('o-1')).rejects.toBeInstanceOf(ConflictException);
    expect(publish).not.toHaveBeenCalled();
  });

  it('updates confirmation/rejection only from PENDING status', async () => {
    updateOne.mockReturnValue({ exec: jest.fn().mockResolvedValue({ acknowledged: true }) });

    await service.markConfirmed('o-10');
    await service.markRejected('o-11', 'INSUFFICIENT_STOCK');

    expect(updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: 'o-10', status: 'PENDING' },
      expect.objectContaining({ $set: { status: 'CONFIRMED' } }),
    );
    expect(updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'o-11', status: 'PENDING' },
      { $set: { status: 'REJECTED', rejectionReason: 'INSUFFICIENT_STOCK' } },
    );
  });
});
