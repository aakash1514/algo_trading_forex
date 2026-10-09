import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InstrumentEntity, EconomicEventEntity, OrderEntity } from '@forexedge/database';
import { OrderValidationService } from './order-validation.service';
import type { OrderRequest } from './dto/submit-order.dto';

const mockInstrumentRepo = () => ({ findOne: jest.fn() });
const mockEconomicEventRepo = () => ({ createQueryBuilder: jest.fn() });
const mockOrderRepo = () => ({ createQueryBuilder: jest.fn() });

const baseDto: OrderRequest = {
  instrument: 'EUR_USD',
  pair: 'EUR/USD',
  direction: 'LONG',
  orderType: 'MARKET',
  lots: 1,
};

const marginOk = async () => ({ valid: true });
const marginFail = async () => ({ valid: false, reason: 'Insufficient margin' });

describe('OrderValidationService', () => {
  let service: OrderValidationService;
  let instrumentRepo: ReturnType<typeof mockInstrumentRepo>;
  let orderRepo: ReturnType<typeof mockOrderRepo>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderValidationService,
        { provide: getRepositoryToken(InstrumentEntity), useFactory: mockInstrumentRepo },
        { provide: getRepositoryToken(EconomicEventEntity), useFactory: mockEconomicEventRepo },
        { provide: getRepositoryToken(OrderEntity), useFactory: mockOrderRepo },
      ],
    }).compile();

    service = module.get(OrderValidationService);
    instrumentRepo = module.get(getRepositoryToken(InstrumentEntity));
    orderRepo = module.get(getRepositoryToken(OrderEntity));

    // Mock Gate 5 (economic calendar) — returns no events by default
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    module.get(getRepositoryToken(EconomicEventEntity))
      .createQueryBuilder.mockReturnValue(qb);

    // Mock Gate 4 daily loss query — returns no loss by default
    const orderQb = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ totalPnl: '0' }),
    };
    orderRepo.createQueryBuilder.mockReturnValue(orderQb);
  });

  // ── Gate 1 ─────────────────────────────────────────────────────────────────
  describe('Gate 1 — instrument active', () => {
    it('rejects when instrument not found', async () => {
      instrumentRepo.findOne.mockResolvedValue(null);
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('rejects when instrument is inactive', async () => {
      instrumentRepo.findOne.mockResolvedValue({ pair: 'EUR/USD', isActive: false });
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not active');
    });

    it('looks the instrument up by its slash-format pair', async () => {
      instrumentRepo.findOne.mockResolvedValue(null);
      await service.validate('user-1', baseDto, marginOk);
      expect(instrumentRepo.findOne).toHaveBeenCalledWith({ where: { pair: 'EUR/USD' } });
    });

    it('passes when instrument is active', async () => {
      instrumentRepo.findOne.mockResolvedValue({ pair: 'EUR/USD', isActive: true });
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(true);
    });
  });

  // ── Gate 2 ─────────────────────────────────────────────────────────────────
  describe('Gate 2 — spread check', () => {
    beforeEach(() => {
      instrumentRepo.findOne.mockResolvedValue({pair: 'EUR/USD', isActive: true });
    });

    it('rejects when spread exceeds maximum', async () => {
      service.updateSpreadCache('EUR/USD', 6);
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Spread too wide');
    });

    it('passes when spread is within limit', async () => {
      service.updateSpreadCache('EUR/USD', 2);
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(true);
    });

    it('passes when no spread data cached yet', async () => {
      // No updateSpreadCache call — simulates service startup
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(true);
    });
  });

  // ── Gate 3 ─────────────────────────────────────────────────────────────────
  describe('Gate 3 — margin check', () => {
    beforeEach(() => {
      instrumentRepo.findOne.mockResolvedValue({ pair: 'EUR/USD', isActive: true });
      service.updateSpreadCache('EUR/USD', 2);
    });

    it('rejects when margin is insufficient', async () => {
      const result = await service.validate('user-1', baseDto, marginFail);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Insufficient margin');
    });

    it('passes when margin is sufficient', async () => {
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(true);
    });
  });

  // ── Gate 4 ─────────────────────────────────────────────────────────────────
  describe('Gate 4 — risk limits', () => {
    beforeEach(() => {
      instrumentRepo.findOne.mockResolvedValue({ pair: 'EUR/USD', isActive: true });
      service.updateSpreadCache('EUR/USD', 2);
    });

    it('rejects when lots exceed maximum', async () => {
      const result = await service.validate(
        'user-1',
        { ...baseDto, lots: 11 },
        marginOk,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exceeds maximum');
    });

    it('rejects when daily loss limit is reached', async () => {
      const orderQb = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ totalPnl: '-500' }),
      };
      orderRepo.createQueryBuilder.mockReturnValue(orderQb);

      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Daily loss limit');
    });

    it('passes when lots and daily loss are within limits', async () => {
      const result = await service.validate('user-1', baseDto, marginOk);
      expect(result.valid).toBe(true);
    });
  });
});