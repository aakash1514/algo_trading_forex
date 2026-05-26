import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { PositionService } from './position.service';

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
  instrument: 'EURUSD',
  pair: 'EURUSD',
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionService,
        { provide: getRepositoryToken(PositionEntity), useFactory: mockPositionRepo },
        { provide: getRepositoryToken(AccountSummaryEntity), useFactory: mockAccountRepo },
        { provide: getRepositoryToken(OrderEntity), useFactory: mockOrderRepo },
        { provide: DataSource, useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get(PositionService);
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