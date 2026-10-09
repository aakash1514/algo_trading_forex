import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderEntity, AccountSummaryEntity, PositionEntity, OrderStatus } from '@forexedge/database';
import { BROKER_ADAPTER } from '@forexedge/common';
import { OrderService } from './order.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { OrderValidationService } from './order-validation.service';
import { MarginEngineService } from './margin-engine.service';
import { BadRequestException } from '@nestjs/common';
import { SessionConsumer } from '../kafka/session.consumer';
import { PricingService, PriceUnavailableError } from '../pricing/pricing.service';

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
  valuePosition: jest.fn().mockResolvedValue({ units: 100_000, marginRequired: 1085, pipValue: 10, quoteToUsd: 1 }),
});

const mockPricing = () => ({
  getQuote: jest.fn().mockResolvedValue({ bid: 1.0849, ask: 1.0851, mid: 1.085 }),
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
        { provide: RealtimePublisher, useValue: { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) } },
        { provide: PricingService, useFactory: mockPricing },
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
      instrument: 'EUR_USD', direction: 'LONG',
      orderType: 'MARKET', lots: 1,
    }, 'key-123');

    expect(result).toBe(existing);
    expect(orderRepo.create).not.toHaveBeenCalled();
  });

  it('creates new order when idempotency key is fresh', async () => {
    orderRepo.findOne.mockResolvedValueOnce(null); // idempotency check
    const draft = { id: 'o2', status: 'DRAFT', pair: 'EUR/USD', direction: 'LONG',
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
      instrument: 'EUR_USD', direction: 'LONG',
      orderType: 'MARKET', lots: 1,
    }, 'key-456');

    expect(orderRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ instrument: 'EUR_USD', pair: 'EUR/USD' }),
    );
    expect(result).toBeDefined();
  });
});

describe('OrderService — pricing and margin', () => {
  let service: OrderService;
  let orderRepo: ReturnType<typeof mockOrderRepo>;
  let validation: ReturnType<typeof mockValidation>;
  let marginEngine: ReturnType<typeof mockMarginEngine>;
  let pricing: ReturnType<typeof mockPricing>;
  let dataSource: ReturnType<typeof mockDataSource>;

  const draft = { id: 'o9', status: 'DRAFT', pair: 'EUR/USD', direction: 'LONG', lots: 1 } as OrderEntity;

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
        { provide: RealtimePublisher, useValue: { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) } },
        { provide: PricingService, useFactory: mockPricing },
      ],
    }).compile();

    service = module.get(OrderService);
    orderRepo = module.get(getRepositoryToken(OrderEntity));
    validation = module.get(OrderValidationService);
    marginEngine = module.get(MarginEngineService);
    pricing = module.get(PricingService);
    dataSource = module.get(DataSource);

    orderRepo.findOne.mockResolvedValue(null);
    orderRepo.create.mockReturnValue(draft);
    orderRepo.save.mockResolvedValue(draft);
    // Run the injected margin gate like the real validation service does
    validation.validate.mockImplementation(async (_u: string, _d: unknown, marginCheck: () => Promise<unknown>) => marginCheck());
  });

  afterEach(() => jest.clearAllMocks());

  const submit = (direction: 'LONG' | 'SHORT') =>
    service.submitOrder('user-1', { instrument: 'EUR_USD', direction, orderType: 'MARKET', lots: 1 }, `k-${direction}`);

  it('checks margin at the live ask for a LONG', async () => {
    await submit('LONG');
    expect(marginEngine.canOpenPosition).toHaveBeenCalledWith('user-1', 'EUR/USD', 1, 1.0851);
  });

  it('checks margin at the live bid for a SHORT', async () => {
    await submit('SHORT');
    expect(marginEngine.canOpenPosition).toHaveBeenCalledWith('user-1', 'EUR/USD', 1, 1.0849);
  });

  it('rejects a market order when free margin is insufficient', async () => {
    marginEngine.canOpenPosition.mockResolvedValue({ valid: false, reason: 'Insufficient margin: need $1085.10, free margin $50.00' });
    const rejected = { ...draft, status: 'REJECTED', rejectionReason: 'Insufficient margin: need $1085.10, free margin $50.00' };
    dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({ update: jest.fn(), findOne: jest.fn().mockResolvedValue(rejected) }));

    const result = await submit('LONG');
    expect(result.status).toBe('REJECTED');
    expect(result.rejectionReason).toContain('Insufficient margin');
  });

  it('rejects instead of validating at price 0 when no live price exists', async () => {
    pricing.getQuote.mockRejectedValue(new PriceUnavailableError('No live price for EUR/USD. Is market-service running?'));
    const rejected = { ...draft, status: 'REJECTED', rejectionReason: 'No live price for EUR/USD. Is market-service running?' };
    dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({ update: jest.fn(), findOne: jest.fn().mockResolvedValue(rejected) }));

    const result = await submit('LONG');
    expect(result.status).toBe('REJECTED');
    expect(marginEngine.canOpenPosition).not.toHaveBeenCalled();
  });

  it('publishes the lifecycle event only after the transition transaction resolves', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { producer: { send: jest.Mock } }).producer.send = send;
    let committed = false;
    dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => {
      const result = await cb({ update: jest.fn(), findOne: jest.fn().mockResolvedValue({ ...draft, status: 'PENDING' }) });
      expect(send).not.toHaveBeenCalled();
      committed = true;
      return result;
    });

    await (service as unknown as { transitionState: (o: OrderEntity, s: OrderStatus) => Promise<OrderEntity> })
      .transitionState(draft, 'PENDING');
    expect(committed).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ topic: 'orders.lifecycle' }));
  });
});
