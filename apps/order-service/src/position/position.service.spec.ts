import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { PositionAlreadyClosedError, PositionService } from './position.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { PricingService } from '../pricing/pricing.service';
import { OpenPairsIndex } from './open-pairs.index';

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
  let dataSource: ReturnType<typeof mockDataSource>;
  const realtime = { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) };
  const pricing = { getSpec: jest.fn(), quoteToUsd: jest.fn(), getQuote: jest.fn() };
  // Every pair has open positions unless a test says otherwise
  const openPairs = { has: jest.fn(), opened: jest.fn(), closed: jest.fn() };
  beforeEach(() => {
    pricing.getSpec.mockResolvedValue({ lotSize: 100_000, pipSize: 0.0001, maxLeverage: null });
    pricing.quoteToUsd.mockResolvedValue(1);
    pricing.getQuote.mockResolvedValue({ bid: 1.0809, ask: 1.0811, mid: 1.081 });
    openPairs.has.mockReturnValue(true);
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
        { provide: OpenPairsIndex, useValue: openPairs },
      ],
    }).compile();

    service = module.get(PositionService);
    positionRepo = module.get(getRepositoryToken(PositionEntity));
    dataSource = module.get(DataSource);
  });

  describe('realtime publishing', () => {
    const tick = { pair: 'EUR/USD', bid: 1.0809, ask: 1.0811, mid: 1.081, timestamp: '2026-10-09T14:00:00Z' };

    // A transaction manager whose locked re-read returns `lockedRow` (null = closed meanwhile)
    const tickManager = (lockedRow: PositionEntity | null) => {
      const qb = {
        update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(), execute: jest.fn(),
      };
      const manager = { findOne: jest.fn().mockResolvedValue(lockedRow), update: jest.fn(), createQueryBuilder: jest.fn(() => qb) };
      dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => cb(manager));
      return { manager, qb };
    };

    it('publishes throttled P&L after a tick updates an open position', async () => {
      const position = makePosition();
      positionRepo.find.mockResolvedValue([position]);
      tickManager(position);

      await service.processTicks([tick]);

      // LONG from 1.08000 to mid 1.08100 = +10 pips at $10/pip
      expect(realtime.positionPnl).toHaveBeenCalledWith(position, 1.081, 10, 100);
    });

    it('re-reads the position under a row lock and moves the account by the locked value', async () => {
      // Loaded with +40 unrealized, but the locked row already holds +60
      positionRepo.find.mockResolvedValue([makePosition({ unrealizedPnl: 40 })]);
      const { manager, qb } = tickManager(makePosition({ unrealizedPnl: 60 }));

      await service.processTicks([tick]);

      expect(manager.findOne).toHaveBeenCalledWith(PositionEntity, {
        where: { id: 'pos-1', isOpen: true }, lock: { mode: 'pessimistic_write' },
      });
      expect(manager.update).toHaveBeenCalledWith(PositionEntity, 'pos-1',
        { currentPrice: 1.081, pipPnl: 10, pipValue: 10, unrealizedPnl: 100 });
      expect(qb.set.mock.calls[0][0].unrealizedPnl()).toBe('unrealized_pnl - :previousPnl + :nextPnl');
      expect(qb.setParameters).toHaveBeenCalledWith({ previousPnl: 60, nextPnl: 100 });
      expect(qb.where).toHaveBeenCalledWith('user_id = :userId', { userId: 'user-1' });
    });

    it('leaves a position closed after it was loaded untouched (exit price, P&L and account)', async () => {
      positionRepo.find.mockResolvedValue([makePosition()]);
      const { manager } = tickManager(null); // closed by a manual close in between

      await service.processTicks([tick]);

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(realtime.positionPnl).not.toHaveBeenCalled();
    });

    it('skips a stop-loss close for a position closed meanwhile and carries on with the others', async () => {
      const hitStop = makePosition({ id: 'pos-sl', stopLoss: 1.0815 }); // LONG, mid 1.081 <= stop
      const other = makePosition({ id: 'pos-2' });
      positionRepo.find.mockResolvedValue([hitStop, other]);
      tickManager(other);
      jest.spyOn(service, 'closePosition').mockRejectedValueOnce(new PositionAlreadyClosedError('pos-sl'));

      await service.processTicks([tick]);

      expect(realtime.positionPnl).toHaveBeenCalledWith(other, 1.081, 10, 100);
    });

    describe('batches', () => {
      const at = (mid: number, pair = 'EUR/USD') => ({ pair, bid: mid - 0.0001, ask: mid + 0.0001, mid, timestamp: '2026-10-09T14:00:00Z' });

      it('skips pairs without open positions without touching the DB', async () => {
        openPairs.has.mockImplementation((pair: string) => pair === 'EUR/USD');
        positionRepo.find.mockResolvedValue([]);

        await service.processTicks([at(150.1, 'USD/JPY'), at(1823.5, 'XAU/USD'), at(1.0810)]);

        expect(positionRepo.find).toHaveBeenCalledTimes(1);
        expect(positionRepo.find).toHaveBeenCalledWith({ where: { pair: 'EUR/USD', isOpen: true } });
      });

      it('loads each pair once and marks P&L once, from the latest tick', async () => {
        const position = makePosition();
        positionRepo.find.mockResolvedValue([position]);
        const { manager } = tickManager(position);

        const users = await service.processTicks([at(1.0805), at(1.0812), at(1.0810)]);

        expect(positionRepo.find).toHaveBeenCalledTimes(1);
        expect(manager.update).toHaveBeenCalledTimes(1);
        // 1.08000 -> latest mid 1.08100 = +10 pips at $10/pip
        expect(manager.update).toHaveBeenCalledWith(PositionEntity, 'pos-1',
          { currentPrice: 1.081, pipPnl: 10, pipValue: 10, unrealizedPnl: 100 });
        expect(users).toEqual(new Set(['user-1']));
      });

      it('checks the stop-loss on every tick: a stop touched mid-batch fills at that tick even if price recovers', async () => {
        const position = makePosition({ stopLoss: 1.0795 }); // LONG from 1.08000
        positionRepo.find.mockResolvedValue([position]);
        const close = jest.spyOn(service, 'closePosition').mockResolvedValue(makePosition({ isOpen: false }));
        const { manager } = tickManager(position);

        await service.processTicks([at(1.0802), at(1.0791), at(1.0810)]);

        // Gapped through 1.0795 to 1.0791: filled at that tick's price, not the level
        expect(close).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith('pos-1', 'STOP_LOSS', 1.0791);
        expect(manager.update).not.toHaveBeenCalled(); // no P&L mark for a closed position
      });

      it('take-profit and stop-loss work for SHORT positions', async () => {
        const tp = makePosition({ id: 'tp', direction: 'SHORT', takeProfit: 1.0790 });
        const sl = makePosition({ id: 'sl', direction: 'SHORT', stopLoss: 1.0815 });
        positionRepo.find.mockResolvedValue([tp, sl]);
        const close = jest.spyOn(service, 'closePosition').mockResolvedValue(makePosition({ isOpen: false }));
        tickManager(null);

        await service.processTicks([at(1.0789), at(1.0816)]);

        expect(close).toHaveBeenCalledWith('tp', 'TAKE_PROFIT', 1.0789);
        expect(close).toHaveBeenCalledWith('sl', 'STOP_LOSS', 1.0816);
      });

      it('one pair failing (e.g. no cross rate yet) does not skip the other pairs in the batch', async () => {
        const eurGbp = makePosition({ id: 'cross', pair: 'EUR/GBP', instrument: 'EUR_GBP' });
        const eurUsd = makePosition();
        positionRepo.find.mockImplementation(async ({ where }: { where: { pair: string } }) =>
          (where.pair === 'EUR/GBP' ? [eurGbp] : [eurUsd]));
        pricing.quoteToUsd.mockImplementation(async (pair: string) => {
          if (pair === 'EUR/GBP') throw new Error('No live price for USD/GBP. Is market-service running?');
          return 1;
        });
        tickManager(eurUsd);

        const users = await service.processTicks([at(0.8571, 'EUR/GBP'), at(1.0810)]);

        expect(realtime.positionPnl).toHaveBeenCalledTimes(1);
        expect(realtime.positionPnl).toHaveBeenCalledWith(eurUsd, 1.081, 10, 100);
        expect(users).toEqual(new Set(['user-1']));
      });

      it('closing a position removes its pair from the index after the commit', async () => {
        const order: string[] = [];
        dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => {
          const result = await cb({
            findOne: jest.fn()
              .mockResolvedValueOnce(makePosition())
              .mockResolvedValueOnce({ id: 'acct-1', balance: 10000, marginUsed: 1080, unrealizedPnl: 0 })
              .mockResolvedValueOnce(makePosition({ isOpen: false })),
            update: jest.fn(),
          });
          order.push('commit');
          return result;
        });
        openPairs.closed.mockImplementation(() => order.push('index'));

        await service.closePosition('pos-1', 'MANUAL', 1.081);

        expect(openPairs.closed).toHaveBeenCalledWith('EUR/USD');
        expect(order).toEqual(['commit', 'index']);
      });
    });

    it('locks the row when closing, and a second close is a 409', async () => {
      const findOne = jest.fn().mockResolvedValue(makePosition({ isOpen: false }));
      dataSource.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => cb({ findOne, update: jest.fn() }));

      await expect(service.closePosition('pos-1', 'MANUAL', 1.081)).rejects.toMatchObject({ status: 409 });
      expect(findOne).toHaveBeenCalledWith(PositionEntity, { where: { id: 'pos-1' }, lock: { mode: 'pessimistic_write' } });
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
      pricing.getSpec.mockResolvedValue({ lotSize: 100_000, pipSize: 0.01, maxLeverage: null });
      pricing.quoteToUsd.mockResolvedValue(1 / 150.5);
      const position = makePosition({ pair: 'USD/JPY', instrument: 'USD_JPY', direction: 'LONG', openPrice: 150 });
      // +50 pips; pip value 100,000 x 0.01 / 150.5 = 6.6445; P&L 50 x 6.6445 = 332.23
      await expect(service.valueAt(position, 150.5)).resolves.toEqual({ pipPnl: 50, pipValue: 6.6445, pnl: 332.23 });
      expect(pricing.getSpec).toHaveBeenCalledWith('USD/JPY');
    });

    it('XAU/USD (100 oz, pip 0.01): +$3.50 at 0.5 lot = 350 pips x $0.50 = +$175', async () => {
      pricing.getSpec.mockResolvedValue({ lotSize: 100, pipSize: 0.01, maxLeverage: 20 });
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