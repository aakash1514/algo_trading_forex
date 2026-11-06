import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InstrumentEntity, EconomicEventEntity, OrderEntity, PositionEntity } from '@forexedge/database';
import { OrderValidationService } from './order-validation.service';
import { MarketHoursPolicy } from '../market/market-hours.policy';
import type { OrderRequest } from './dto/submit-order.dto';

const mockInstrumentRepo = () => ({ findOne: jest.fn() });
const mockEconomicEventRepo = () => ({ createQueryBuilder: jest.fn() });
const mockOrderRepo = () => ({ createQueryBuilder: jest.fn() });
const mockPositionRepo = () => ({ createQueryBuilder: jest.fn() });

const exposureQb = (openLots: string) => ({
  select: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  getRawOne: jest.fn().mockResolvedValue({ openLots }),
});

const baseDto: OrderRequest = {
  instrument: 'EUR_USD',
  pair: 'EUR/USD',
  direction: 'LONG',
  orderType: 'MARKET',
  lots: 1,
};

// instruments rows as stored (avg_spread is a price difference, like ask - bid).
// XAU/USD's avg_spread is the median 2022 Dukascopy spread.
const eurUsdRow = { pair: 'EUR/USD', isActive: true, pipSize: 0.0001, avgSpread: 0.0001 };
const xauUsdRow = { pair: 'XAU/USD', isActive: true, pipSize: 0.01, avgSpread: 0.368 };

// A live quote as PricingService.getQuote returns it: 1x the average spread.
const eurUsdQuote = { bid: 1.08500, ask: 1.08510 };

const marginOk = async () => ({ valid: true });
const marginFail = async () => ({ valid: false, reason: 'Insufficient margin' });

// Open unless a test closes it (the real clock would make results depend on the day)
const marketHours = { enforced: true, status: jest.fn() };

describe('OrderValidationService', () => {
  let service: OrderValidationService;
  let instrumentRepo: ReturnType<typeof mockInstrumentRepo>;
  let orderRepo: ReturnType<typeof mockOrderRepo>;
  let positionRepo: ReturnType<typeof mockPositionRepo>;
  let calendarQb: { where: jest.Mock; andWhere: jest.Mock; getMany: jest.Mock };
  let orderQb: { select: jest.Mock; innerJoin: jest.Mock; where: jest.Mock; andWhere: jest.Mock; getRawOne: jest.Mock };

  beforeEach(async () => {
    marketHours.status.mockReset().mockReturnValue({ open: true });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderValidationService,
        { provide: getRepositoryToken(InstrumentEntity), useFactory: mockInstrumentRepo },
        { provide: getRepositoryToken(EconomicEventEntity), useFactory: mockEconomicEventRepo },
        { provide: getRepositoryToken(OrderEntity), useFactory: mockOrderRepo },
        { provide: getRepositoryToken(PositionEntity), useFactory: mockPositionRepo },
        { provide: MarketHoursPolicy, useValue: marketHours },
      ],
    }).compile();

    service = module.get(OrderValidationService);
    instrumentRepo = module.get(getRepositoryToken(InstrumentEntity));
    orderRepo = module.get(getRepositoryToken(OrderEntity));
    positionRepo = module.get(getRepositoryToken(PositionEntity));

    // Gate 4 exposure query — no open lots by default
    positionRepo.createQueryBuilder.mockReturnValue(exposureQb('0'));

    // Mock Gate 5 (economic calendar) — returns no events by default
    calendarQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    module.get(getRepositoryToken(EconomicEventEntity))
      .createQueryBuilder.mockReturnValue(calendarQb);

    // Mock Gate 4 daily loss query — returns no loss by default
    orderQb = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ totalPnl: '0' }),
    };
    orderRepo.createQueryBuilder.mockReturnValue(orderQb);
  });

  // ── Gate 5 ─────────────────────────────────────────────────────────────────
  describe('Gate 5 — economic calendar warning', () => {
    it('looks for events within ±30 min of the order, never blocking', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-28T18:05:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        instrumentRepo.findOne.mockResolvedValue(eurUsdRow);
        const qb = calendarQb;
        qb.getMany.mockResolvedValue([{ currency: 'USD', title: 'FOMC meeting, October 27-28', impact: 'HIGH', timeSource: 'expected' }]);
        const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
        expect(result.valid).toBe(true);
        const call = qb.andWhere.mock.calls.find(([sql]: [string]) => sql.includes('scheduled_at'));
        expect(call?.[0]).toBe('e.scheduled_at BETWEEN :windowStart AND :windowEnd');
        expect(call?.[1]).toEqual({
          windowStart: new Date('2026-10-28T17:35:00Z'),
          windowEnd: new Date('2026-10-28T18:35:00Z'),
        });
        expect(qb.where).toHaveBeenCalledWith('e.currency IN (:...currencies)', { currencies: ['EUR', 'USD'] });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── Gate 1 ─────────────────────────────────────────────────────────────────
  describe('Gate 1 — instrument active', () => {
    it('rejects when instrument not found', async () => {
      instrumentRepo.findOne.mockResolvedValue(null);
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('rejects when instrument is inactive', async () => {
      instrumentRepo.findOne.mockResolvedValue({ ...eurUsdRow, isActive: false });
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not active');
    });

    it('looks the instrument up by its slash-format pair', async () => {
      instrumentRepo.findOne.mockResolvedValue(null);
      await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(instrumentRepo.findOne).toHaveBeenCalledWith({ where: { pair: 'EUR/USD' } });
    });

    it('passes when instrument is active', async () => {
      instrumentRepo.findOne.mockResolvedValue({ ...eurUsdRow, isActive: true });
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result.valid).toBe(true);
    });
  });

  // ── Gate 2 ─────────────────────────────────────────────────────────────────
  describe('Gate 2 — spread of the quote being traded', () => {
    const xauDto: OrderRequest = { ...baseDto, instrument: 'XAU_USD', pair: 'XAU/USD', lots: 0.1 };
    const marginSpy = jest.fn(marginOk);

    beforeEach(() => {
      marginSpy.mockClear();
      instrumentRepo.findOne.mockResolvedValue(eurUsdRow);
    });

    it.each([
      ['1.99x', { bid: 1.08500, ask: 1.085199 }, true],
      ['2.0x (exactly on the limit)', { bid: 1.08500, ask: 1.08520 }, true],
      ['2.01x', { bid: 1.08500, ask: 1.085201 }, false],
    ])('EUR/USD at %s average is valid=%s', async (_label, quote, valid) => {
      const result = await service.validate('user-1', baseDto, quote, marginSpy);
      expect(result.valid).toBe(valid);
      if (!valid) {
        expect(result.reason).toBe('Spread too wide for EUR/USD: 0.00020 is 2.01x the average 0.0001 (limit 2x)');
        expect(marginSpy).not.toHaveBeenCalled(); // later gates never run
      }
    });

    it('judges gold against its own average, not a fixed pip limit', async () => {
      instrumentRepo.findOne.mockResolvedValue(xauUsdRow);
      // 36.8 pips is a normal gold spread; a flat 5-pip rule would block it
      const normal = await service.validate('user-1', xauDto, { bid: 1823.463, ask: 1823.831 }, marginOk);
      expect(normal.valid).toBe(true);

      const wide = await service.validate('user-1', xauDto, { bid: 1823.463, ask: 1824.20268 }, marginOk);
      expect(wide).toEqual({
        valid: false,
        reason: 'Spread too wide for XAU/USD: 0.740 is 2.01x the average 0.368 (limit 2x)',
      });
    });

    it('fails closed when the instrument has no average spread', async () => {
      instrumentRepo.findOne.mockResolvedValue({ ...eurUsdRow, avgSpread: null });
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result).toEqual({
        valid: false,
        reason: 'Spread check unavailable for EUR/USD: no average spread configured',
      });
    });
  });

  // ── Gate 3 ─────────────────────────────────────────────────────────────────
  describe('Gate 0 — order type', () => {
    it.each(['LIMIT', 'STOP', 'TRAILING_STOP', 'OCO'] as const)('rejects %s: only MARKET orders are executed', async (orderType) => {
      const result = await service.validate('user-1', { ...baseDto, orderType }, eurUsdQuote, marginOk);
      expect(result).toEqual({ valid: false, reason: `${orderType} orders are not supported yet; only MARKET orders are executed` });
      expect(instrumentRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('Gate 1b — market hours', () => {
    it("rejects while the instrument's market is closed, judged by its type", async () => {
      instrumentRepo.findOne.mockResolvedValue({ ...xauUsdRow, type: 'METAL' });
      marketHours.status.mockReturnValue({ open: false, reason: 'DAILY_BREAK', reopensAt: new Date('2026-10-12T22:00:00Z') });
      const result = await service.validate('user-1', { ...baseDto, instrument: 'XAU_USD', pair: 'XAU/USD' }, eurUsdQuote, marginOk);
      expect(marketHours.status).toHaveBeenCalledWith('METAL');
      expect(result).toEqual({ valid: false, reason: 'Market closed for XAU/USD: daily break 17:00-18:00 New York (reopens 2026-10-12 22:00 UTC)' });
    });
  });

  describe('Gate 2b — SL/TP on the right side of the exit price', () => {
    beforeEach(() => instrumentRepo.findOne.mockResolvedValue(eurUsdRow));

    it.each([
      [{ direction: 'LONG', stopLoss: 1.0800, takeProfit: 1.0900 }, true, undefined],
      [{ direction: 'LONG', stopLoss: 1.0860 }, false, 'Stop loss 1.086 must be below the bid 1.085 for a LONG position'],
      [{ direction: 'SHORT', stopLoss: 1.0900, takeProfit: 1.0800 }, true, undefined],
      [{ direction: 'SHORT', takeProfit: 1.0860 }, false, 'Take profit 1.086 must be below the ask 1.0851 for a SHORT position'],
    ] as const)('%j -> valid=%s', async (levels, valid, reason) => {
      const result = await service.validate('user-1', { ...baseDto, ...levels }, eurUsdQuote, marginOk);
      expect(result.valid).toBe(valid);
      expect(result.reason).toBe(reason);
    });
  });

  describe('Gate 3 — margin check', () => {
    beforeEach(() => {
      instrumentRepo.findOne.mockResolvedValue({ ...eurUsdRow, isActive: true });
    });

    it('rejects when margin is insufficient', async () => {
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginFail);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Insufficient margin');
    });

    it('passes when margin is sufficient', async () => {
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result.valid).toBe(true);
    });
  });

  // ── Gate 4 ─────────────────────────────────────────────────────────────────
  describe('Gate 4 — risk limits', () => {
    beforeEach(() => {
      instrumentRepo.findOne.mockResolvedValue({ ...eurUsdRow, isActive: true });
    });

    it('rejects when a single order exceeds the per-pair maximum', async () => {
      const result = await service.validate(
        'user-1',
        { ...baseDto, lots: 11 },
        eurUsdQuote,
        marginOk,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('would exceed 10 lots');
    });

    it('counts existing open exposure on the pair', async () => {
      positionRepo.createQueryBuilder.mockReturnValue(exposureQb('9.5'));
      const result = await service.validate('user-1', { ...baseDto, lots: 1 }, eurUsdQuote, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('9.5 lots open on EUR/USD');
    });

    it('allows an order that stays within the exposure limit', async () => {
      positionRepo.createQueryBuilder.mockReturnValue(exposureQb('9'));
      const result = await service.validate('user-1', { ...baseDto, lots: 1 }, eurUsdQuote, marginOk);
      expect(result.valid).toBe(true);
    });

    it('scopes the exposure query to the user, the slash-format pair and open positions', async () => {
      const qb = exposureQb('0');
      positionRepo.createQueryBuilder.mockReturnValue(qb);
      await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(qb.where).toHaveBeenCalledWith('p.user_id = :userId', { userId: 'user-1' });
      expect(qb.andWhere).toHaveBeenCalledWith('p.pair = :pair', { pair: 'EUR/USD' });
      expect(qb.andWhere).toHaveBeenCalledWith('p.is_open = true');
    });

    it('starts the daily-loss window at UTC midnight', async () => {
      await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      const call = orderQb.andWhere.mock.calls.find(([sql]: [string]) => sql.includes('todayStart'));
      const todayStart: Date = call[1].todayStart;
      expect(todayStart.getUTCHours()).toBe(0);
      expect(todayStart.getUTCMinutes()).toBe(0);
      expect(todayStart.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
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

      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Daily loss limit');
    });

    it('passes when lots and daily loss are within limits', async () => {
      const result = await service.validate('user-1', baseDto, eurUsdQuote, marginOk);
      expect(result.valid).toBe(true);
    });
  });
});