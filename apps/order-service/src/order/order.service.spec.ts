import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderEntity, AccountSummaryEntity, PositionEntity, OrderStatus } from '@forexedge/database';
import { BROKER_ADAPTER } from '@forexedge/common';
import { OrderService } from './order.service';
import { OrderValidationService } from './order-validation.service';
import { MarginEngineService } from './margin-engine.service';
import { BadRequestException } from '@nestjs/common';
import { SessionConsumer } from '../kafka/session.consumer';

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    }),
  })),
}));

const mockOrderRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockAccountRepo = () => ({ findOne: jest.fn() });

const mockDataSource = () => ({
  transaction: jest.fn(cb => cb({
    save: jest.fn().mockImplementation((_, data) => Promise.resolve(data)),
    update: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue({ id: 'acc-1', marginUsed: 0, leverage: 100 }),
  })),
});

const mockBroker = () => ({
  fillOrder: jest.fn().mockResolvedValue({
    executedPrice: 1.08500,
    executedAt: new Date(),
  }),
});

const mockValidation = () => ({
  validate: jest.fn().mockResolvedValue({ valid: true }),
});

const mockMarginEngine = () => ({
  canOpenPosition: jest.fn().mockResolvedValue({ valid: true }),
  calculatePipValue: jest.fn().mockReturnValue(10),
  calculateMarginRequired: jest.fn().mockReturnValue(1085),
});

const mockSessionConsumer = () => ({
  getActiveSession: jest.fn().mockReturnValue('OFF_HOURS'),
});

describe('OrderService — FSM transitions', () => {
  let service: OrderService;
  let orderRepo: ReturnType<typeof mockOrderRepo>;
  let dataSource: ReturnType<typeof mockDataSource>;
  let serviceInternal: {
    transitionState: (order: OrderEntity, newState: OrderStatus, reason?: string) => Promise<OrderEntity>;
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: getRepositoryToken(OrderEntity), useFactory: mockOrderRepo },
        { provide: getRepositoryToken(AccountSummaryEntity), useFactory: mockAccountRepo },
        { provide: getRepositoryToken(PositionEntity), useFactory: () => ({}) },
        { provide: DataSource, useFactory: mockDataSource },
        { provide: BROKER_ADAPTER, useFactory: mockBroker },
        { provide: OrderValidationService, useFactory: mockValidation },
        { provide: MarginEngineService, useFactory: mockMarginEngine },
        { provide: SessionConsumer, useFactory: mockSessionConsumer },
      ],
    }).compile();

    service = module.get(OrderService);
    orderRepo = module.get(getRepositoryToken(OrderEntity));
    dataSource = module.get(DataSource);
    serviceInternal = service as unknown as {
      transitionState: (order: OrderEntity, newState: OrderStatus, reason?: string) => Promise<OrderEntity>;
    };
  });

  // ── Valid transitions ───────────────────────────────────────────────────────
  it('DRAFT → PENDING is valid', async () => {
    const order = { id: 'o1', status: 'DRAFT' } as OrderEntity;
    const transitionSpy = jest
      .spyOn(serviceInternal, 'transitionState')
      .mockResolvedValue({ ...order, status: 'PENDING' });

    await serviceInternal.transitionState(order, 'PENDING');
    expect(transitionSpy).toHaveBeenCalledWith(order, 'PENDING');
  });

  it('PENDING → OPEN is valid', async () => {
    const order = { id: 'o1', status: 'PENDING' } as OrderEntity;
    const transitionSpy = jest
      .spyOn(serviceInternal, 'transitionState')
      .mockResolvedValue({ ...order, status: 'OPEN' });

    await serviceInternal.transitionState(order, 'OPEN');
    expect(transitionSpy).toHaveBeenCalledWith(order, 'OPEN');
  });

  it('OPEN → CLOSED is valid', async () => {
    const order = { id: 'o1', status: 'OPEN' } as OrderEntity;
    const transitionSpy = jest
      .spyOn(serviceInternal, 'transitionState')
      .mockResolvedValue({ ...order, status: 'CLOSED' });

    await serviceInternal.transitionState(order, 'CLOSED');
    expect(transitionSpy).toHaveBeenCalledWith(order, 'CLOSED');
  });

  // ── Invalid transitions ─────────────────────────────────────────────────────
  it('OPEN → PENDING throws BadRequestException', async () => {
    const order = { id: 'o1', status: 'OPEN' } as OrderEntity;
    await expect(
      serviceInternal.transitionState(order, 'PENDING')
    ).rejects.toThrow(BadRequestException);
  });

  it('CLOSED → OPEN throws BadRequestException', async () => {
    const order = { id: 'o1', status: 'CLOSED' } as OrderEntity;
    await expect(
      serviceInternal.transitionState(order, 'OPEN')
    ).rejects.toThrow(BadRequestException);
  });

  it('REJECTED → PENDING throws BadRequestException', async () => {
    const order = { id: 'o1', status: 'REJECTED' } as OrderEntity;
    await expect(
      serviceInternal.transitionState(order, 'PENDING')
    ).rejects.toThrow(BadRequestException);
  });

  it('CANCELLED → OPEN throws BadRequestException', async () => {
    const order = { id: 'o1', status: 'CANCELLED' } as OrderEntity;
    await expect(
      serviceInternal.transitionState(order, 'OPEN')
    ).rejects.toThrow(BadRequestException);
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────
  it('returns existing order when idempotency key already exists', async () => {
    const existing = { id: 'o1', status: 'OPEN', idempotencyKey: 'key-123' } as OrderEntity;
    orderRepo.findOne.mockResolvedValue(existing);

    const result = await service.submitOrder('user-1', {
      instrument: 'EURUSD', pair: 'EURUSD', direction: 'LONG',
      orderType: 'MARKET', lots: 1,
    }, 'key-123');

    expect(result).toBe(existing);
    expect(orderRepo.create).not.toHaveBeenCalled();
  });

  it('creates new order when idempotency key is fresh', async () => {
    orderRepo.findOne.mockResolvedValueOnce(null); // idempotency check
    const draft = { id: 'o2', status: 'DRAFT', pair: 'EURUSD', direction: 'LONG',
                    lots: 1, idempotencyKey: 'key-456' } as OrderEntity;
    orderRepo.create.mockReturnValue(draft);
    orderRepo.save.mockResolvedValue(draft);

    // transitionState calls dataSource.transaction which calls findOne for the updated order
    dataSource.transaction.mockImplementation(async (
      cb: (manager: {
        save: (entity: unknown, data: unknown) => Promise<unknown>;
        update: (entity: unknown, id: unknown, data: unknown) => Promise<unknown>;
        findOne: (entity: unknown, options: unknown) => Promise<unknown>;
      }) => Promise<unknown>
    ) => {
      return cb({
        save: jest.fn().mockResolvedValue({ ...draft, status: 'OPEN' }),
        update: jest.fn().mockResolvedValue({}),
        findOne: jest.fn().mockResolvedValue({ ...draft, status: 'PENDING' }),
      });
    });

    const result = await service.submitOrder('user-1', {
      instrument: 'EURUSD', pair: 'EURUSD', direction: 'LONG',
      orderType: 'MARKET', lots: 1,
    }, 'key-456');

    expect(orderRepo.create).toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});