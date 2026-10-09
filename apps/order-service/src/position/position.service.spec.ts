import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { PositionService } from './position.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';

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
  });

  afterEach(() => jest.clearAllMocks());

  // ── calculatePipPnl ─────────────────────────────────────────────────────────
  describe('calculatePipPnl', () => {
    it('LONG position profit: price moves up 10 pips', () => {
      const position = makePosition({ direction: 'LONG', openPrice: 1.08000 });
      const result = service.calculatePipPnl(position, 1.08100);
      expect(result).toBe(10);
    });

    it('LONG position loss: price moves down 10 pips', () => {
      const position = makePosition({ direction: 'LONG', openPrice: 1.08000 });
      const result = service.calculatePipPnl(position, 1.07900);
      expect(result).toBe(-10);
    });

    it('SHORT position profit: price moves down 10 pips', () => {
      const position = makePosition({ direction: 'SHORT', openPrice: 1.08000 });
      const result = service.calculatePipPnl(position, 1.07900);
      expect(result).toBe(10);
    });

    it('SHORT position loss: price moves up 10 pips', () => {
      const position = makePosition({ direction: 'SHORT', openPrice: 1.08000 });
      const result = service.calculatePipPnl(position, 1.08100);
      expect(result).toBe(-10);
    });

    it('JPY pair — uses pip size 0.01', () => {
      const position = makePosition({
        pair: 'USDJPY',
        direction: 'LONG',
        openPrice: 150.00,
      });
      // 50 pip move up
      const result = service.calculatePipPnl(position, 150.50);
      expect(result).toBe(50);
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