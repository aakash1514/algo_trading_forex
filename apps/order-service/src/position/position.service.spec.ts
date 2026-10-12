import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { marketStatus } from '@forexedge/common';
import { PositionEntity, OrderEntity } from '@forexedge/database';
import { PositionAlreadyClosedError, PositionService, type NormalizedTick } from './position.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { PricingService, PriceUnavailableError } from '../pricing/pricing.service';
import { OpenPairsIndex } from './open-pairs.index';
import { MarketHoursPolicy } from '../market/market-hours.policy';

// A position row as stored (decimals already converted by the entity transformer)
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
  openedAt: new Date('2026-10-07T12:00:00Z'),
  closedAt: null,
  closeReason: null,
  pendingExitPrice: null,
  pendingExitReason: null,
  exitTriggeredAt: null,
  order: {} as OrderEntity,
  user: {} as PositionEntity['user'],
  ...overrides,
} as PositionEntity);

// Query builder double: records the update it builds; `affected` for the result
const builder = (affected = 1) => ({
  update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
  setParameters: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({ affected }),
});

// Ticks on a Wednesday (all markets open) unless a test sets the time
const tickAt = (mid: number, pair = 'EUR/USD', timestamp = '2026-10-07T14:00:00.000Z'): NormalizedTick =>
  ({ pair, bid: mid - 0.0001, ask: mid + 0.0001, mid, timestamp });

describe('PositionService', () => {
  let service: PositionService;
  const positionRepo = { find: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const realtime = { positionPnl: jest.fn(), positionsChanged: jest.fn().mockResolvedValue(undefined) };
  const pricing = { getSpec: jest.fn(), quoteToUsd: jest.fn(), getQuote: jest.fn(), getLastQuote: jest.fn(), getInstrumentKind: jest.fn() };
  const openPairs = { has: jest.fn(), opened: jest.fn(), closed: jest.fn() };
  // The real clock rules, enforced (the production setting)
  const marketHours = { enforced: true, status: jest.fn((kind, at?: Date) => marketStatus(kind, at)) };

  // Transaction double for markToMarket/closePosition/updateExitLevels
  const manager = (rows: (PositionEntity | null)[]) => {
    const qb = builder();
    const m = {
      findOne: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
      qb,
    };
    for (const row of rows) m.findOne.mockResolvedValueOnce(row);
    dataSource.transaction.mockImplementation(async (cb: (x: unknown) => Promise<unknown>) => cb(m));
    return m;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    pricing.getSpec.mockResolvedValue({ lotSize: 100_000, pipSize: 0.0001, maxLeverage: null });
    pricing.quoteToUsd.mockResolvedValue(1);
    pricing.getQuote.mockResolvedValue({ bid: 1.0809, ask: 1.0811, mid: 1.081 });
    pricing.getLastQuote.mockResolvedValue({ bid: 1.0809, ask: 1.0811, mid: 1.081 });
    pricing.getInstrumentKind.mockResolvedValue('MAJOR');
    openPairs.has.mockReturnValue(true);
    marketHours.enforced = true;
    positionRepo.find.mockResolvedValue([]);
    positionRepo.createQueryBuilder.mockReturnValue(builder());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionService,
        { provide: getRepositoryToken(PositionEntity), useValue: positionRepo },
        { provide: getRepositoryToken(OrderEntity), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: RealtimePublisher, useValue: realtime },
        { provide: PricingService, useValue: pricing },
        { provide: OpenPairsIndex, useValue: openPairs },
        { provide: MarketHoursPolicy, useValue: marketHours },
      ],
    }).compile();
    service = module.get(PositionService);
  });

  // Open positions per pair, plus the held-exit query (pending_exit_price NOT NULL)
  const openPositions = (byPair: Record<string, PositionEntity[]>, held: PositionEntity[] = []) => {
    positionRepo.find.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      ('pendingExitPrice' in where ? held : byPair[where['pair'] as string] ?? []));
  };

  describe('marking P&L', () => {
    it('re-reads the position under a row lock, writes its P&L and publishes it', async () => {
      const position = makePosition();
      openPositions({ 'EUR/USD': [position] });
      const m = manager([position]);

      await service.processTicks([tickAt(1.0810)]);

      expect(m.findOne).toHaveBeenCalledWith(PositionEntity, { where: { id: 'pos-1', isOpen: true }, lock: { mode: 'pessimistic_write' } });
      // LONG from 1.08000 to mid 1.08100 = +10 pips at $10/pip
      expect(m.update).toHaveBeenCalledWith(PositionEntity, 'pos-1', { currentPrice: 1.081, pipPnl: 10, pipValue: 10, unrealizedPnl: 100 });
      expect(realtime.positionPnl).toHaveBeenCalledWith(position, 1.081, 10, 100);
    });

    it('never writes the account: open P&L is summed from the positions on read', async () => {
      openPositions({ 'EUR/USD': [makePosition()] });
      const m = manager([makePosition()]);
      await service.processTicks([tickAt(1.0810)]);
      expect(m.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('leaves a position closed after it was loaded untouched', async () => {
      openPositions({ 'EUR/USD': [makePosition()] });
      const m = manager([null]); // closed by a manual close in between
      await service.processTicks([tickAt(1.0810)]);
      expect(m.update).not.toHaveBeenCalled();
      expect(realtime.positionPnl).not.toHaveBeenCalled();
    });

    it('loads each pair once and marks P&L once, from the latest tick', async () => {
      const position = makePosition();
      openPositions({ 'EUR/USD': [position] });
      const m = manager([position]);

      const users = await service.processTicks([tickAt(1.0805), tickAt(1.0812), tickAt(1.0810)]);

      expect(positionRepo.find).toHaveBeenCalledWith({ where: { pair: 'EUR/USD', isOpen: true } });
      expect(m.update).toHaveBeenCalledTimes(1);
      expect(m.update).toHaveBeenCalledWith(PositionEntity, 'pos-1', { currentPrice: 1.081, pipPnl: 10, pipValue: 10, unrealizedPnl: 100 });
      expect(users).toEqual(new Set(['user-1']));
    });

    it('skips pairs without open positions without touching the DB', async () => {
      openPairs.has.mockImplementation((pair: string) => pair === 'EUR/USD');
      await service.processTicks([tickAt(150.1, 'USD/JPY'), tickAt(1823.5, 'XAU/USD'), tickAt(1.0810)]);
      expect(positionRepo.find).toHaveBeenCalledWith({ where: { pair: 'EUR/USD', isOpen: true } });
      expect(positionRepo.find).not.toHaveBeenCalledWith({ where: { pair: 'USD/JPY', isOpen: true } });
    });

    it('converts a cross pair with the rate from the same batch, not Redis', async () => {
      const cross = makePosition({ id: 'cross', pair: 'EUR/GBP', instrument: 'EUR_GBP' });
      openPairs.has.mockImplementation((pair: string) => pair === 'EUR/GBP');
      openPositions({ 'EUR/GBP': [cross] });
      manager([cross]);

      await service.processTicks([tickAt(1.2700, 'GBP/USD'), tickAt(0.8571, 'EUR/GBP')]);

      const streamMids = pricing.quoteToUsd.mock.calls[0][2] as Map<string, number>;
      expect(pricing.quoteToUsd).toHaveBeenCalledWith('EUR/GBP', 0.8571, expect.any(Map));
      expect(streamMids.get('GBP/USD')).toBe(1.27);
    });

    it('a pair failing does not skip the other pairs in the batch', async () => {
      openPositions({ 'EUR/GBP': [makePosition({ id: 'cross', pair: 'EUR/GBP' })], 'EUR/USD': [makePosition()] });
      pricing.quoteToUsd.mockImplementation(async (pair: string) => {
        if (pair === 'EUR/GBP') throw new PriceUnavailableError('No live price for USD/GBP');
        return 1;
      });
      manager([makePosition()]);

      await service.processTicks([tickAt(0.8571, 'EUR/GBP'), tickAt(1.0810)]);

      expect(realtime.positionPnl).toHaveBeenCalledTimes(1);
      expect(realtime.positionPnl).toHaveBeenCalledWith(expect.objectContaining({ id: 'pos-1' }), 1.081, 10, 100);
    });
  });

  describe('stop-loss / take-profit', () => {
    const closeSpy = () => jest.spyOn(service, 'closePosition').mockResolvedValue(makePosition({ isOpen: false }));

    it('checks every tick: a stop touched mid-batch is held, then booked at that tick\'s price', async () => {
      const position = makePosition({ stopLoss: 1.0795 }); // LONG from 1.08000
      openPositions({ 'EUR/USD': [position] });
      const hold = builder();
      positionRepo.createQueryBuilder.mockReturnValue(hold);
      const close = closeSpy();

      // Gaps through 1.0795 to 1.0791, then recovers
      await service.processTicks([tickAt(1.0802), tickAt(1.0791, 'EUR/USD', '2026-10-07T14:00:01.000Z'), tickAt(1.0810)]);

      // 1. the trigger is committed on the position first, at the TICK's price and time
      expect(hold.set).toHaveBeenCalledWith({
        pendingExitPrice: 1.0791, pendingExitReason: 'STOP_LOSS', exitTriggeredAt: new Date('2026-10-07T14:00:01.000Z'),
      });
      expect(hold.where).toHaveBeenCalledWith('id = :positionId AND is_open AND pending_exit_price IS NULL', { positionId: 'pos-1' });
      // 2. then booked at that price, not the 1.0795 level
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith('pos-1', 'STOP_LOSS', 1.0791, expect.any(Map));
      expect(realtime.positionPnl).not.toHaveBeenCalled(); // no P&L mark for an exiting position
    });

    it('take-profit and stop-loss work for SHORT positions', async () => {
      const tp = makePosition({ id: 'tp', direction: 'SHORT', takeProfit: 1.0790 });
      const sl = makePosition({ id: 'sl', direction: 'SHORT', stopLoss: 1.0815 });
      openPositions({ 'EUR/USD': [tp, sl] });
      const close = closeSpy();

      await service.processTicks([tickAt(1.0789), tickAt(1.0816)]);

      expect(close).toHaveBeenCalledWith('tp', 'TAKE_PROFIT', 1.0789, expect.any(Map));
      expect(close).toHaveBeenCalledWith('sl', 'STOP_LOSS', 1.0816, expect.any(Map));
    });

    it('does not book a trigger that lost the race (position closed or already triggered)', async () => {
      openPositions({ 'EUR/USD': [makePosition({ stopLoss: 1.0795 })] });
      positionRepo.createQueryBuilder.mockReturnValue(builder(0)); // UPDATE matched nothing
      const close = closeSpy();
      await service.processTicks([tickAt(1.0790)]);
      expect(close).not.toHaveBeenCalled();
    });

    it('a booking failure keeps the exit held in the DB; the next batch books it at the trigger price', async () => {
      openPositions({ 'EUR/USD': [makePosition({ stopLoss: 1.0795 })] });
      const close = jest.spyOn(service, 'closePosition')
        .mockRejectedValueOnce(new PriceUnavailableError('No live price for USD/GBP'));

      await expect(service.processTicks([tickAt(1.0790)])).resolves.toEqual(new Set(['user-1']));
      expect(close).toHaveBeenCalledWith('pos-1', 'STOP_LOSS', 1.079, expect.any(Map));

      // Next batch: the held exit comes back from the DB (not from memory) and books at 1.0790
      const held = makePosition({ stopLoss: 1.0795, pendingExitPrice: 1.079, pendingExitReason: 'STOP_LOSS', exitTriggeredAt: new Date() });
      openPositions({ 'EUR/USD': [held] }, [held]);
      close.mockResolvedValueOnce(makePosition({ isOpen: false }));
      await service.processTicks([tickAt(1.0812)]);
      expect(close).toHaveBeenLastCalledWith('pos-1', 'STOP_LOSS', 1.079, expect.any(Map));
      expect(realtime.positionPnl).not.toHaveBeenCalled(); // a held position is never marked
    });

    it('a held exit survives a restart: a fresh service books it from the DB', async () => {
      const held = makePosition({ pendingExitPrice: 1.079, pendingExitReason: 'STOP_LOSS', exitTriggeredAt: new Date() });
      openPositions({}, [held]);
      const close = closeSpy();
      openPairs.has.mockReturnValue(false); // nothing in memory knows about it

      await service.processTicks([tickAt(1.0812)]);

      expect(positionRepo.find).toHaveBeenCalledWith({ where: { isOpen: true, pendingExitPrice: expect.anything() } });
      expect(close).toHaveBeenCalledWith('pos-1', 'STOP_LOSS', 1.079, expect.any(Map));
    });
  });

  describe('market hours', () => {
    it('ignores ticks stamped while the market is closed (no P&L, no stops)', async () => {
      openPositions({ 'EUR/USD': [makePosition({ stopLoss: 1.0795 })] });
      const close = jest.spyOn(service, 'closePosition');
      const m = manager([makePosition()]);

      // Saturday: FX closed
      await service.processTicks([tickAt(1.0700, 'EUR/USD', '2026-10-10T12:00:00.000Z')]);

      expect(close).not.toHaveBeenCalled();
      expect(m.update).not.toHaveBeenCalled();
    });

    it('a stop gapped through over the weekend fills at the first tick after the reopen', async () => {
      // LONG 1.08000, stop 1.0795. Friday close 1.0802, weekend ticks ignored, Sunday reopen at 1.0760
      const position = makePosition({ stopLoss: 1.0795 });
      openPositions({ 'EUR/USD': [position] });
      const hold = builder();
      positionRepo.createQueryBuilder.mockReturnValue(hold);
      const close = jest.spyOn(service, 'closePosition').mockResolvedValue(makePosition({ isOpen: false }));
      manager([position]);

      await service.processTicks([
        tickAt(1.0802, 'EUR/USD', '2026-10-09T20:59:30.000Z'), // Fri 16:59 EDT: open, above the stop
        tickAt(1.0700, 'EUR/USD', '2026-10-10T12:00:00.000Z'), // Saturday: ignored
        tickAt(1.0760, 'EUR/USD', '2026-10-11T21:00:00.000Z'), // Sun 17:00 EDT: first tick after reopen
        tickAt(1.0750, 'EUR/USD', '2026-10-11T21:00:01.000Z'),
      ]);

      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith('pos-1', 'STOP_LOSS', 1.076, expect.any(Map));
      expect(hold.set).toHaveBeenCalledWith(expect.objectContaining({ exitTriggeredAt: new Date('2026-10-11T21:00:00.000Z') }));
    });

    it('gold ticks during the daily break are ignored, FX ticks at the same time are not', async () => {
      pricing.getInstrumentKind.mockImplementation(async (pair: string) => (pair === 'XAU/USD' ? 'METAL' : 'MAJOR'));
      openPositions({ 'XAU/USD': [makePosition({ id: 'gold', pair: 'XAU/USD' })], 'EUR/USD': [makePosition()] });
      manager([makePosition()]);

      // Monday 17:30 EDT: gold in its daily break, FX open
      await service.processTicks([tickAt(1823.5, 'XAU/USD', '2026-10-12T21:30:00.000Z'), tickAt(1.0810, 'EUR/USD', '2026-10-12T21:30:00.000Z')]);

      expect(realtime.positionPnl).toHaveBeenCalledTimes(1);
      expect(realtime.positionPnl).toHaveBeenCalledWith(expect.objectContaining({ id: 'pos-1' }), 1.081, 10, 100);
    });

    it('processes closed-market ticks when MARKET_HOURS_GATE=false (development)', async () => {
      marketHours.enforced = false;
      marketHours.status.mockReturnValueOnce({ open: true });
      openPositions({ 'EUR/USD': [makePosition()] });
      manager([makePosition()]);
      await service.processTicks([tickAt(1.0810, 'EUR/USD', '2026-10-10T12:00:00.000Z')]);
      expect(realtime.positionPnl).toHaveBeenCalled();
    });
  });

  describe('closePosition', () => {
    it('locks the row, books the account with relative updates, clears the held exit', async () => {
      const m = manager([makePosition({ unrealizedPnl: 25, pendingExitPrice: 1.081, pendingExitReason: 'STOP_LOSS' }), makePosition({ isOpen: false })]);

      await service.closePosition('pos-1', 'STOP_LOSS', 1.081);

      expect(m.findOne).toHaveBeenNthCalledWith(1, PositionEntity, { where: { id: 'pos-1' }, lock: { mode: 'pessimistic_write' } });
      expect(m.update).toHaveBeenCalledWith(PositionEntity, 'pos-1', expect.objectContaining({
        isOpen: false, closeReason: 'STOP_LOSS', currentPrice: 1.081, realizedPnl: 100, unrealizedPnl: 0,
        pendingExitPrice: null, pendingExitReason: null,
      }));
      const set = m.qb.set.mock.calls[0][0];
      expect(set.balance()).toBe('balance + :realizedPnl');
      expect(set.marginUsed()).toBe('GREATEST(0, margin_used - :releasedMargin)');
      expect(set).not.toHaveProperty('unrealizedPnl');
      expect(m.qb.setParameters).toHaveBeenCalledWith({ realizedPnl: 100, releasedMargin: 1080 });
    });

    it('keeps the order entry price and publishes only after the commit', async () => {
      let committed = false;
      const m = { findOne: jest.fn().mockResolvedValueOnce(makePosition()).mockResolvedValueOnce(makePosition({ isOpen: false })), update: jest.fn(), createQueryBuilder: jest.fn(() => builder()) };
      dataSource.transaction.mockImplementation(async (cb: (x: unknown) => Promise<unknown>) => {
        const result = await cb(m);
        expect(realtime.positionsChanged).not.toHaveBeenCalled();
        expect(openPairs.closed).not.toHaveBeenCalled();
        committed = true;
        return result;
      });

      await service.closePosition('pos-1', 'MANUAL', 1.081);

      const orderUpdate = m.update.mock.calls.find(([entity]: [unknown]) => entity === OrderEntity);
      expect(orderUpdate[2]).toEqual(expect.objectContaining({ status: 'CLOSED' }));
      expect(orderUpdate[2]).not.toHaveProperty('executedPrice');
      expect(committed).toBe(true);
      expect(openPairs.closed).toHaveBeenCalledWith('EUR/USD');
      expect(realtime.positionsChanged).toHaveBeenCalledWith('user-1', 'pos-1');
    });

    it('a second close is a 409', async () => {
      manager([makePosition({ isOpen: false })]);
      await expect(service.closePosition('pos-1', 'MANUAL', 1.081)).rejects.toBeInstanceOf(PositionAlreadyClosedError);
    });
  });

  describe('closeAtMarket (manual close)', () => {
    const closeSpy = () => jest.spyOn(service, 'closePosition').mockResolvedValue(makePosition({ isOpen: false }));
    afterEach(() => jest.useRealTimers());
    const wednesday = () => jest.useFakeTimers({ now: new Date('2026-10-07T14:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });

    it('closes a LONG at the live bid, scoped to the requesting user', async () => {
      wednesday();
      positionRepo.findOne.mockResolvedValue(makePosition({ direction: 'LONG' }));
      const spy = closeSpy();
      await service.closeAtMarket('user-1', 'pos-1');
      expect(positionRepo.findOne).toHaveBeenCalledWith({ where: { id: 'pos-1', userId: 'user-1' } });
      expect(spy).toHaveBeenCalledWith('pos-1', 'MANUAL', 1.0809);
    });

    it('closes a SHORT at the live ask', async () => {
      wednesday();
      positionRepo.findOne.mockResolvedValue(makePosition({ direction: 'SHORT' }));
      const spy = closeSpy();
      await service.closeAtMarket('user-1', 'pos-1');
      expect(spy).toHaveBeenCalledWith('pos-1', 'MANUAL', 1.0811);
    });

    it('is rejected (409) while the market is closed, with the reopening time', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-10T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
      positionRepo.findOne.mockResolvedValue(makePosition());
      const spy = closeSpy();
      await expect(service.closeAtMarket('user-1', 'pos-1')).rejects.toMatchObject({
        status: 409,
        message: 'Market closed for EUR/USD: weekend (reopens 2026-10-11 21:00 UTC)',
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("404s for another user's position", async () => {
      positionRepo.findOne.mockResolvedValue(null);
      await expect(service.closeAtMarket('user-2', 'pos-1')).rejects.toThrow('Position pos-1 not found');
    });
  });

  describe('updateExitLevels (PATCH /positions/:id)', () => {
    it('sets a LONG stop below the bid and a take-profit above it, using the last known price', async () => {
      const m = manager([makePosition()]);
      const result = await service.updateExitLevels('user-1', 'pos-1', { stopLoss: 1.0750, takeProfit: 1.0900 });
      expect(m.findOne).toHaveBeenCalledWith(PositionEntity, { where: { id: 'pos-1', userId: 'user-1' }, lock: { mode: 'pessimistic_write' } });
      expect(pricing.getLastQuote).toHaveBeenCalledWith('EUR/USD');
      expect(m.update).toHaveBeenCalledWith(PositionEntity, 'pos-1', { stopLoss: 1.075, takeProfit: 1.09 });
      expect(result).toMatchObject({ stopLoss: 1.075, takeProfit: 1.09 });
      expect(realtime.positionsChanged).toHaveBeenCalledWith('user-1', 'pos-1');
    });

    it('clears a level with null and keeps an absent one', async () => {
      const m = manager([makePosition({ stopLoss: 1.0750, takeProfit: 1.0900 })]);
      await service.updateExitLevels('user-1', 'pos-1', { takeProfit: null });
      expect(m.update).toHaveBeenCalledWith(PositionEntity, 'pos-1', { stopLoss: 1.075, takeProfit: null });
    });

    it.each([
      ['LONG stop at/above the bid', 'LONG', { stopLoss: 1.0809 }, 'Stop loss 1.0809 must be below the bid 1.0809 for a LONG position'],
      ['LONG take-profit below the bid', 'LONG', { takeProfit: 1.0800 }, 'Take profit 1.08 must be above the bid 1.0809 for a LONG position'],
      ['SHORT stop below the ask', 'SHORT', { stopLoss: 1.0805 }, 'Stop loss 1.0805 must be above the ask 1.0811 for a SHORT position'],
      ['SHORT take-profit above the ask', 'SHORT', { takeProfit: 1.0820 }, 'Take profit 1.082 must be below the ask 1.0811 for a SHORT position'],
    ])('rejects a %s (400)', async (_label, direction, changes, message) => {
      const m = manager([makePosition({ direction: direction as 'LONG' | 'SHORT' })]);
      await expect(service.updateExitLevels('user-1', 'pos-1', changes)).rejects.toMatchObject({ status: 400, message });
      expect(m.update).not.toHaveBeenCalled();
    });

    it('works while the market is closed (validated against the last known price)', async () => {
      pricing.getQuote.mockRejectedValue(new PriceUnavailableError('No live price'));
      const m = manager([makePosition()]);
      await service.updateExitLevels('user-1', 'pos-1', { stopLoss: 1.0700 });
      expect(m.update).toHaveBeenCalled();
    });

    it("404s for another user's position, 409 for a closed one or one with a triggered exit", async () => {
      manager([null]);
      await expect(service.updateExitLevels('user-2', 'pos-1', { stopLoss: 1.07 })).rejects.toMatchObject({ status: 404 });
      manager([makePosition({ isOpen: false })]);
      await expect(service.updateExitLevels('user-1', 'pos-1', { stopLoss: 1.07 })).rejects.toMatchObject({ status: 409 });
      manager([makePosition({ pendingExitPrice: 1.079, pendingExitReason: 'STOP_LOSS' })]);
      await expect(service.updateExitLevels('user-1', 'pos-1', { stopLoss: 1.07 })).rejects.toMatchObject({ status: 409 });
    });

    it('requires at least one field and a user id', async () => {
      await expect(service.updateExitLevels('user-1', 'pos-1', {})).rejects.toMatchObject({ status: 400 });
      await expect(service.updateExitLevels(undefined as unknown as string, 'pos-1', { stopLoss: 1 })).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('valueAt (DB pip size, current quote->USD rate)', () => {
    it('LONG EUR/USD +10 pips at 1 lot = +$100', async () => {
      await expect(service.valueAt(makePosition({ direction: 'LONG', openPrice: 1.08 }), 1.081)).resolves.toEqual({ pipPnl: 10, pipValue: 10, pnl: 100 });
    });

    it('SHORT EUR/USD -10 pips at 1 lot = -$100', async () => {
      await expect(service.valueAt(makePosition({ direction: 'SHORT', openPrice: 1.08 }), 1.081)).resolves.toEqual({ pipPnl: -10, pipValue: 10, pnl: -100 });
    });

    it('USD/JPY uses the DB pip size 0.01 and converts at the current price', async () => {
      pricing.getSpec.mockResolvedValue({ lotSize: 100_000, pipSize: 0.01, maxLeverage: null });
      pricing.quoteToUsd.mockResolvedValue(1 / 150.5);
      const position = makePosition({ pair: 'USD/JPY', instrument: 'USD_JPY', direction: 'LONG', openPrice: 150 });
      // +50 pips; pip value 100,000 x 0.01 / 150.5 = 6.6445; P&L 50 x 6.6445 = 332.23
      await expect(service.valueAt(position, 150.5)).resolves.toEqual({ pipPnl: 50, pipValue: 6.6445, pnl: 332.23 });
    });

    it('XAU/USD (100 oz, pip 0.01): +$3.50 at 0.5 lot = 350 pips x $0.50 = +$175', async () => {
      pricing.getSpec.mockResolvedValue({ lotSize: 100, pipSize: 0.01, maxLeverage: 20 });
      const position = makePosition({ pair: 'XAU/USD', instrument: 'XAU_USD', lots: 0.5, openPrice: 2400 });
      await expect(service.valueAt(position, 2403.5)).resolves.toEqual({ pipPnl: 350, pipValue: 0.5, pnl: 175 });
    });
  });

  describe('calculateUnrealizedPnl', () => {
    it.each([[10, 10, 100], [-5, 10, -50], [0, 10, 0], [3, 7.77, 23.31]])('%d pips x $%d = $%d', (pips, value, pnl) => {
      expect(service.calculateUnrealizedPnl(pips, value)).toBe(pnl);
    });
  });
});
