import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { PositionService } from './position.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { PricingService } from '../pricing/pricing.service';

const mockPositionRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockAccountRepo = () => ({
  findOne: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockOrderRepo = () => ({
  update: jest.fn(),
});

const mockDataSource = () => ({
  transaction: jest.fn(),
});

// Helper to build a minimal PositionEntity
const makePosition = (overrides: Partial<PositionEntity> = {}): PositionEntity => ({
  id: 'pos-1',
  orderId: 'ord-1',
  userId: 'user-1',
  instrument: 'EUR_USD',
  pair: 'EUR/USD',
  direction: 'LONG',
  lots: 1,
  openPrice: 1.08000,
  currentPrice: 1.08000,
  pipPnl: 0,
  unrealizedPnl: 0,
  realizedPnl: null,
  swapAccrued: 0,
  pipValue: 10,
  marginUsed: 1080,
  stopLoss: null,
  takeProfit: null,
  isOpen: true,
  openedAt: new Date(),
  closedAt: null,
  closeReason: null,
  order: {} as any,
  user: {} as any,
  ...overrides,
} as PositionEntity);

describe('PositionService — P&L calculation', () => {
  let service: PositionService;
  let positionRepo: ReturnType<typeof mockPositionRepo>;
  let accountRepo: ReturnType<typeof mockAccountRepo>;
  let dataSource: ReturnType<typeof mockDataSource>;
  const realtime = { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) };
  const pricing = { getSpec: jest.fn(), quoteToUsd: jest.fn(), getQuote: jest.fn() };
  beforeEach(() => {
    pricing.getSpec.mockResolvedValue({ lotSize: 100_000, pipSize: 0.0001 });
    pricing.quoteToUsd.mockResolvedValue(1);
    pricing.getQuote.mockResolvedValue({ bid: 1.0809, ask: 1.0811, mid: 1.081 });
  });
  afterEach(() => jest.clearAllMocks());

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionService,
        { provide: getRepositoryToken(PositionEntity), useFactory: mockPositionRepo },
        { provide: getRepositoryToken(AccountSummaryEntity), useFactory: mockAccountRepo },
        { provide: getRepositoryToken(OrderEntity), useFactory: mockOrderRepo },
        { provide: DataSource, useFactory: mockDataSource },
        { provide: RealtimePublisher, useValue: realtime },
        { provide: PricingService, useValue: pricing },
      ],
    }).compile();

    service = module.get(PositionService);
    positionRepo = module.get(getRepositoryToken(PositionEntity));
    accountRepo = module.get(getRepositoryToken(AccountSummaryEntity));
    dataSource = module.get(DataSource);
  });

  describe('realtime publishing', () => {
    const tick = { pair: 'EUR/USD', bid: 1.0809, ask: 1.0811, mid: 1.081, timestamp: '2026-10-09T14:00:00Z' };

    it('publishes throttled P&L after a tick updates an open position', async () => {
      const position = makePosition();
      positionRepo.find.mockResolvedValue([position]);
      const qb = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), execute: jest.fn() };
      accountRepo.createQueryBuilder.mockReturnValue(qb);

      await service.recalculatePositions(tick);

      // LONG from 1.08000 to mid 1.08100 = +10 pips at $10/pip
      expect(realtime.positionPnl).toHaveBeenCalledWith(position, 1.081, 10, 100);
    });

    it('publishes a snapshot only after the close transaction committed', async () => {
      const closed = makePosition({ isOpen: false });
      let committed = false;
      dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => {
        const result = await cb({
          findOne: jest.fn()
            .mockResolvedValueOnce(makePosition())
            .mockResolvedValueOnce({ id: 'acct-1', balance: 10000, marginUsed: 1080, unrealizedPnl: 0 })
            .mockResolvedValueOnce(closed),
          update: jest.fn(),
        });
        expect(realtime.positionsChanged).not.toHaveBeenCalled();
        committed = true;
        return result;
      });

      await service.closePosition('pos-1', 'MANUAL', 1.081);

      expect(committed).toBe(true);
      expect(realtime.positionsChanged).toHaveBeenCalledWith('user-1', 'pos-1');
    });

    it('does not overwrite the order entry price when closing', async () => {
      const update = jest.fn();
      dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => cb({
        findOne: jest.fn()
          .mockResolvedValueOnce(makePosition())
          .mockResolvedValueOnce({ id: 'acct-1', balance: 10000, marginUsed: 1080, unrealizedPnl: 0 })
          .mockResolvedValueOnce(makePosition({ isOpen: false })),
        update,
      }));

      await service.closePosition('pos-1', 'MANUAL', 1.081);

      const orderUpdate = update.mock.calls.find(([entity]: [unknown]) => entity === OrderEntity);
      expect(orderUpdate[2]).toEqual(expect.objectContaining({ status: 'CLOSED' }));
      expect(orderUpdate[2]).not.toHaveProperty('executedPrice');
    });
  });

  describe('closeAtMarket', () => {
    const closeSpy = () => jest.spyOn(service, 'closePosition').mockResolvedValue(makePosition({ isOpen: false }));

    it('closes a LONG at the live bid, scoped to the requesting user', async () => {
      positionRepo.findOne.mockResolvedValue(makePosition({ direction: 'LONG' }));
      const spy = closeSpy();
      await service.closeAtMarket('user-1', 'pos-1');
      expect(positionRepo.findOne).toHaveBeenCalledWith({ where: { id: 'pos-1', userId: 'user-1' } });
      expect(spy).toHaveBeenCalledWith('pos-1', 'MANUAL', 1.0809);
    });

    it('closes a SHORT at the live ask', async () => {
      positionRepo.findOne.mockResolvedValue(makePosition({ direction: 'SHORT' }));
      const spy = closeSpy();
      await service.closeAtMarket('user-1', 'pos-1');
      expect(spy).toHaveBeenCalledWith('pos-1', 'MANUAL', 1.0811);
    });

    it("404s for another user's position", async () => {
      positionRepo.findOne.mockResolvedValue(null);
      await expect(service.closeAtMarket('user-2', 'pos-1')).rejects.toThrow('Position pos-1 not found');
    });
  });

  afterEach(() => jest.clearAllMocks());

  // ── valueAt (DB pip size, current quote->USD rate) ─────────────────────────
  describe('valueAt', () => {
    it('LONG EUR/USD +10 pips at 1 lot = +$100', async () => {
      const position = makePosition({ direction: 'LONG', openPrice: 1.08 });
      await expect(service.valueAt(position, 1.081)).resolves.toEqual({ pipPnl: 10, pipValue: 10, pnl: 100 });
    });

    it('SHORT EUR/USD -10 pips at 1 lot = -$100', async () => {
      const position = makePosition({ direction: 'SHORT', openPrice: 1.08 });
      await expect(service.valueAt(position, 1.081)).resolves.toEqual({ pipPnl: -10, pipValue: 10, pnl: -100 });
    });

    it('USD/JPY uses the DB pip size 0.01 and converts at the current price', async () => {
      pricing.getSpec.mockResolvedValue({ lotSize: 100_000, pipSize: 0.01 });
      pricing.quoteToUsd.mockResolvedValue(1 / 150.5);
      const position = makePosition({ pair: 'USD/JPY', instrument: 'USD_JPY', direction: 'LONG', openPrice: 150 });
      // +50 pips; pip value 100,000 x 0.01 / 150.5 = 6.6445; P&L 50 x 6.6445 = 332.23
      await expect(service.valueAt(position, 150.5)).resolves.toEqual({ pipPnl: 50, pipValue: 6.6445, pnl: 332.23 });
      expect(pricing.getSpec).toHaveBeenCalledWith('USD/JPY');
    });

    it('XAU/USD (100 oz, pip 0.01): +$3.50 at 0.5 lot = 350 pips x $0.50 = +$175', async () => {
      pricing.getSpec.mockResolvedValue({ lotSize: 100, pipSize: 0.01 });
      const position = makePosition({ pair: 'XAU/USD', instrument: 'XAU_USD', lots: 0.5, openPrice: 2400 });
      await expect(service.valueAt(position, 2403.5)).resolves.toEqual({ pipPnl: 350, pipValue: 0.5, pnl: 175 });
    });
  });

  // ── calculateUnrealizedPnl ──────────────────────────────────────────────────
  describe('calculateUnrealizedPnl', () => {
    it('10 pips profit with $10 pip value = $100', () => {
      const result = service.calculateUnrealizedPnl(10, 10);
      expect(result).toBe(100);
    });

    it('negative pips = negative P&L', () => {
      const result = service.calculateUnrealizedPnl(-5, 10);
      expect(result).toBe(-50);
    });

    it('zero pips = zero P&L', () => {
      const result = service.calculateUnrealizedPnl(0, 10);
      expect(result).toBe(0);
    });

    it('fractional pip value rounds to 2 decimal places', () => {
      const result = service.calculateUnrealizedPnl(3, 7.77);
      expect(result).toBe(23.31);
    });
  });
});