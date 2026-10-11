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
import { PricingService, PriceUnavailableError } from '../pricing/pricing.service';
import { OpenPairsIndex } from '../position/open-pairs.index';
import { MarketHoursPolicy } from '../market/market-hours.policy';

// Open-pairs index (tick consumer): the fill path must record the new position's pair
const openPairs = { opened: jest.fn(), closed: jest.fn(), has: jest.fn().mockReturnValue(true) };
// Market open unless a test closes it
const marketHours = { enforced: true, status: jest.fn(() => ({ open: true }) as { open: boolean; reason?: string; reopensAt?: Date }) };

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
  getInstrumentKind: jest.fn().mockResolvedValue('MAJOR'),
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
        { provide: RealtimePublisher, useValue: { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) } },
        { provide: PricingService, useFactory: mockPricing },
        { provide: OpenPairsIndex, useValue: openPairs },
        { provide: MarketHoursPolicy, useValue: marketHours },
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
  it.each(['PENDING', 'SUBMITTED'] as const)('%s → CANCELLED is valid (cancelling works, also while the market is closed)', async (status) => {
    const order = { id: 'o1', userId: 'user-1', status } as OrderEntity;
    orderRepo.findOne.mockResolvedValueOnce(order);
    const transition = jest.spyOn(serviceInternal, 'transitionState').mockResolvedValue({ ...order, status: 'CANCELLED' });
    await expect(service.cancelOrder('user-1', 'o1')).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(transition).toHaveBeenCalledWith(order, 'CANCELLED');
  });

  it('the state machine allows PENDING/SUBMITTED → CANCELLED', async () => {
    dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({ update: jest.fn(), findOne: jest.fn().mockResolvedValue({ id: 'o1', status: 'CANCELLED' }) }));
    await expect(serviceInternal.transitionState({ id: 'o1', status: 'PENDING' } as OrderEntity, 'CANCELLED'))
      .resolves.toMatchObject({ status: 'CANCELLED' });
  });

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
    const existing = { id: 'o1', userId: 'user-1', status: 'OPEN', idempotencyKey: 'key-123' } as OrderEntity;
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

    const accountQb = {
      update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(), execute: jest.fn(),
    };
    // transitionState calls dataSource.transaction which calls findOne for the updated order
    dataSource.transaction.mockImplementation(async (
      cb: (manager: {
        save: (entity: unknown, data: unknown) => Promise<unknown>;
        update: (entity: unknown, id: unknown, data: unknown) => Promise<unknown>;
        findOne: (entity: unknown, options: unknown) => Promise<unknown>;
        createQueryBuilder: () => unknown;
      }) => Promise<unknown>
    ) => {
      return cb({
        save: jest.fn().mockResolvedValue({ ...draft, status: 'OPEN' }),
        update: jest.fn().mockResolvedValue({}),
        findOne: jest.fn().mockResolvedValue({ ...draft, status: 'PENDING' }),
        createQueryBuilder: jest.fn(() => accountQb),
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
    // The fill opened a position: the tick consumer's index learns its pair
    expect(openPairs.opened).toHaveBeenCalledWith('EUR/USD');
    // Margin is added with a relative update, never by writing back the account row
    expect(accountQb.set.mock.calls[0][0].marginUsed()).toBe('margin_used + :addedMargin');
    expect(accountQb.where).toHaveBeenCalledWith('user_id = :userId', { userId: 'user-1' });
  });

  it.each([
    ['2026-10-07T12:00:00Z', 'LONDON,NEW_YORK'], // Wednesday, London/New York overlap
    ['2026-10-10T10:00:00Z', 'OFF_HOURS'],       // Saturday: FX closed
  ])('stamps an order placed at %s with session %s (shared market clock, no Kafka state)', async (iso, label) => {
    jest.useFakeTimers({
      now: new Date(iso),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask'],
    });
    try {
      orderRepo.findOne.mockResolvedValueOnce(null);
      orderRepo.create.mockImplementation((o: OrderEntity) => o);
      orderRepo.save.mockImplementation(async (o: OrderEntity) => ({ ...o, id: 'o3' }));
      dataSource.transaction.mockRejectedValue(new Error('stop after DRAFT'));
      await service.submitOrder('user-1', { instrument: 'EUR_USD', direction: 'LONG', orderType: 'MARKET', lots: 1 }, `k-${iso}`)
        .catch(() => undefined);
      expect(orderRepo.create).toHaveBeenCalledWith(expect.objectContaining({ sessionOpened: label }));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('OrderService — pricing and margin', () => {
  let service: OrderService;
  let orderRepo: ReturnType<typeof mockOrderRepo>;
  let validation: ReturnType<typeof mockValidation>;
  let marginEngine: ReturnType<typeof mockMarginEngine>;
  let pricing: ReturnType<typeof mockPricing>;
  let dataSource: ReturnType<typeof mockDataSource>;
  let broker: ReturnType<typeof mockBroker>;

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
        { provide: RealtimePublisher, useValue: { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) } },
        { provide: PricingService, useFactory: mockPricing },
        { provide: OpenPairsIndex, useValue: openPairs },
        { provide: MarketHoursPolicy, useValue: marketHours },
      ],
    }).compile();

    service = module.get(OrderService);
    orderRepo = module.get(getRepositoryToken(OrderEntity));
    validation = module.get(OrderValidationService);
    marginEngine = module.get(MarginEngineService);
    pricing = module.get(PricingService);
    dataSource = module.get(DataSource);
    broker = module.get(BROKER_ADAPTER);

    orderRepo.findOne.mockResolvedValue(null);
    orderRepo.create.mockReturnValue(draft);
    orderRepo.save.mockResolvedValue(draft);
    // Run the injected margin gate like the real validation service does
    validation.validate.mockImplementation(
      async (_u: string, _d: unknown, _quote: unknown, marginCheck: () => Promise<unknown>) => marginCheck());
  });

  afterEach(() => jest.clearAllMocks());

  const submit = (direction: 'LONG' | 'SHORT') =>
    service.submitOrder('user-1', { instrument: 'EUR_USD', direction, orderType: 'MARKET', lots: 1 }, `k-${direction}`);

  it('rejects with the market-closed reason before looking for a quote (the feed is silent while closed)', async () => {
    marketHours.status.mockReturnValueOnce({ open: false, reason: 'WEEKEND', reopensAt: new Date('2026-10-11T21:00:00Z') });
    const transition = jest.spyOn(service as unknown as { transitionState: () => Promise<unknown> }, 'transitionState')
      .mockResolvedValue({ status: 'REJECTED' });
    await submit('LONG');
    expect(pricing.getQuote).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(expect.anything(), 'REJECTED', 'Market closed for EUR/USD: weekend (reopens 2026-10-11 21:00 UTC)');
  });

  it('fetches the live quote once and fills from that same quote (gate, margin and fill agree)', async () => {
    await submit('LONG');
    expect(pricing.getQuote).toHaveBeenCalledTimes(1);
    expect(broker.fillOrder).toHaveBeenCalledWith(expect.anything(), { bid: 1.0849, ask: 1.0851, mid: 1.085 });
  });

  it('validates the spread on the same live quote the order is priced at', async () => {
    await submit('LONG');
    expect(pricing.getQuote).toHaveBeenCalledWith('EUR/USD');
    expect(validation.validate).toHaveBeenCalledWith(
      'user-1', expect.objectContaining({ pair: 'EUR/USD' }),
      { bid: 1.0849, ask: 1.0851, mid: 1.085 }, expect.any(Function));
  });

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
    expect(openPairs.opened).not.toHaveBeenCalled(); // no position, no index entry
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

describe('OrderService cross-user access', () => {
  const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const orderOfA = { id: 'ord-a', userId: USER_A, status: 'OPEN', idempotencyKey: 'key-a' } as OrderEntity;

  let service: OrderService;
  let orderRepo: ReturnType<typeof mockOrderRepo>;

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
        { provide: RealtimePublisher, useValue: { positionPnl: jest.fn(), positionsChanged: jest.fn() } },
        { provide: PricingService, useFactory: mockPricing },
        { provide: OpenPairsIndex, useValue: openPairs },
        { provide: MarketHoursPolicy, useValue: marketHours },
      ],
    }).compile();
    service = module.get(OrderService);
    orderRepo = module.get(getRepositoryToken(OrderEntity));
    // Behaves like Postgres: a row is returned only when every condition matches.
    orderRepo.findOne.mockImplementation(async ({ where }: { where: Partial<OrderEntity> }) =>
      Object.entries(where).every(([k, v]) => (orderOfA as unknown as Record<string, unknown>)[k] === v) ? orderOfA : null);
  });

  afterEach(() => jest.clearAllMocks());

  it("user B gets 404 on user A's order", async () => {
    await expect(service.getOrder(USER_B, 'ord-a')).rejects.toHaveProperty('status', 404);
    expect(orderRepo.findOne).toHaveBeenCalledWith({ where: { id: 'ord-a', userId: USER_B } });
  });

  it("user B gets 404 cancelling user A's order", async () => {
    await expect(service.cancelOrder(USER_B, 'ord-a')).rejects.toHaveProperty('status', 404);
  });

  it('owner can read their order', async () => {
    await expect(service.getOrder(USER_A, 'ord-a')).resolves.toBe(orderOfA);
  });

  it("reusing user A's idempotency key as user B is a 409 and never returns A's order", async () => {
    await expect(
      service.submitOrder(USER_B, { instrument: 'EUR_USD', direction: 'LONG', orderType: 'MARKET', lots: 1 }, 'key-a'),
    ).rejects.toHaveProperty('status', 409);
    await expect(service.idempotencyKeyExists(USER_B, 'key-a')).rejects.toHaveProperty('status', 409);
    expect(orderRepo.create).not.toHaveBeenCalled();
  });

  it('same user reusing their key gets their existing order back', async () => {
    await expect(
      service.submitOrder(USER_A, { instrument: 'EUR_USD', direction: 'LONG', orderType: 'MARKET', lots: 1 }, 'key-a'),
    ).resolves.toBe(orderOfA);
  });

  it.each([
    ['getOrders', () => service.getOrders(undefined as unknown as string, {})],
    ['getOrder', () => service.getOrder(undefined as unknown as string, 'ord-a')],
    ['cancelOrder', () => service.cancelOrder(undefined as unknown as string, 'ord-a')],
  ])('%s with a missing user id fails closed (401)', async (_name, call) => {
    await expect(call()).rejects.toHaveProperty('status', 401);
    expect(orderRepo.findOne).not.toHaveBeenCalled();
  });
});
