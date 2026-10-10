import { marketStatus } from '@forexedge/common';
import type { PositionEntity } from '@forexedge/database';
import { StopOutService } from './stop-out.service';
import { PositionAlreadyClosedError } from '../position/position.service';
import { PriceUnavailableError } from '../pricing/pricing.service';

// Open positions as stored; unrealizedPnl is the last mark
const position = (id: string, pair: string, unrealizedPnl: number, direction: 'LONG' | 'SHORT' = 'LONG') =>
  ({ id, pair, direction, lots: 1, unrealizedPnl, userId: 'user-1' } as PositionEntity);

const quotes: Record<string, { bid: number; ask: number }> = {
  'EUR/USD': { bid: 1.0800, ask: 1.0801 },
  'GBP/USD': { bid: 1.2600, ask: 1.2602 },
  'XAU/USD': { bid: 1820.10, ask: 1820.47 },
};

function setup(levels: (number | null)[], open: PositionEntity[], now = new Date('2026-10-07T14:00:00Z')) {
  const positionRepo = { find: jest.fn().mockResolvedValue(open) };
  // Margin level read before the stop-out and after each close
  const accounts = { getAccountSummary: jest.fn() };
  for (const level of levels) accounts.getAccountSummary.mockResolvedValueOnce({ marginLevel: level });
  const positions = { closePosition: jest.fn(async (id: string) => ({ id, realizedPnl: -100 })) };
  const pricing = {
    getInstrumentKind: jest.fn(async (pair: string) => (pair === 'XAU/USD' ? 'METAL' : 'MAJOR')),
    getQuote: jest.fn(async (pair: string) => quotes[pair]),
  };
  const marketHours = { enforced: true, status: jest.fn((kind) => marketStatus(kind, now)) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new StopOutService(positionRepo as any, accounts as any, positions as any, pricing as any, marketHours as any);
  return { service, positionRepo, accounts, positions, pricing };
}

describe('StopOutService', () => {
  it('below 50%: closes the biggest loser first and stops as soon as the level is back above 50%', async () => {
    const open = [position('worst', 'GBP/USD', -900), position('mid', 'EUR/USD', -300, 'SHORT'), position('best', 'EUR/USD', 50)];
    const { service, positionRepo, positions } = setup([42, 63], open);

    await service.check('user-1');

    // Ordered by unrealized P&L ascending: biggest loser first
    expect(positionRepo.find).toHaveBeenCalledWith({ where: { userId: 'user-1', isOpen: true }, order: { unrealizedPnl: 'ASC' } });
    // One close brought the level to 63%: nothing else is closed
    expect(positions.closePosition).toHaveBeenCalledTimes(1);
    expect(positions.closePosition).toHaveBeenCalledWith('worst', 'STOP_OUT', 1.26); // LONG closes at the bid
  });

  it('keeps closing, re-reading the margin level after each close, until it recovers', async () => {
    const open = [position('a', 'GBP/USD', -900), position('b', 'EUR/USD', -300, 'SHORT'), position('c', 'EUR/USD', -10)];
    const { service, positions, accounts } = setup([30, 41, 55], open);

    await service.check('user-1');

    expect(positions.closePosition.mock.calls).toEqual([['a', 'STOP_OUT', 1.26], ['b', 'STOP_OUT', 1.0801]]); // SHORT at the ask
    expect(accounts.getAccountSummary).toHaveBeenCalledTimes(3);
  });

  it('closes everything if the level never recovers, ending with no open positions', async () => {
    const open = [position('a', 'GBP/USD', -900), position('b', 'EUR/USD', -300)];
    const { service, positions } = setup([20, 35, null], open);
    await service.check('user-1');
    expect(positions.closePosition).toHaveBeenCalledTimes(2);
  });

  it('skips positions whose market is closed (gold in its daily break) and closes the next loser', async () => {
    const open = [position('gold', 'XAU/USD', -1500), position('eur', 'EUR/USD', -200)];
    // Monday 17:30 EDT: gold in its daily break, FX open
    const { service, positions } = setup([40, 60], open, new Date('2026-10-12T21:30:00Z'));
    await service.check('user-1');
    expect(positions.closePosition.mock.calls).toEqual([['eur', 'STOP_OUT', 1.08]]);
  });

  it('does nothing while every market is closed: it runs on the first tick after the reopen', async () => {
    const { service, positions } = setup([30], [position('a', 'EUR/USD', -900)], new Date('2026-10-10T12:00:00Z'));
    await service.check('user-1');
    expect(positions.closePosition).not.toHaveBeenCalled();
  });

  it('skips a position without a live price, and one closed meanwhile by another path', async () => {
    const open = [position('noprice', 'GBP/USD', -900), position('raced', 'EUR/USD', -500), position('ok', 'EUR/USD', -100)];
    const { service, positions, pricing } = setup([30, 35, 60], open);
    pricing.getQuote.mockImplementationOnce(async () => { throw new PriceUnavailableError('No live price for GBP/USD'); });
    positions.closePosition.mockImplementationOnce(async () => { throw new PositionAlreadyClosedError('raced'); });

    await service.check('user-1');

    expect(positions.closePosition.mock.calls.map(([id]) => id)).toEqual(['raced', 'ok']);
  });

  it.each([
    [75, 'margin call'],
    [120, 'margin warning'],
    [400, 'healthy'],
    [null, 'no open positions'],
  ])('at %s%% (%s) closes nothing and writes nothing to the positions', async (level) => {
    const { service, positions, positionRepo } = setup([level as number | null], [position('a', 'EUR/USD', -100)]);
    await service.check('user-1');
    expect(positions.closePosition).not.toHaveBeenCalled();
    expect(positionRepo.find).not.toHaveBeenCalled();
  });

  it('is idempotent per user: an overlapping check does not close anything twice', async () => {
    const open = [position('a', 'GBP/USD', -900), position('b', 'EUR/USD', -300)];
    const { service, positions, accounts } = setup([], open);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    accounts.getAccountSummary
      .mockImplementationOnce(async () => { await gate; return { marginLevel: 30 }; })
      .mockResolvedValue({ marginLevel: 70 });

    const first = service.check('user-1');
    await service.check('user-1'); // overlaps the first: returns immediately
    release();
    await first;

    expect(positions.closePosition).toHaveBeenCalledTimes(1);
    expect(accounts.getAccountSummary).toHaveBeenCalledTimes(2); // first check + after its one close
  });
});

describe('StopOutService alerts', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('logs a worse band at once, the same or a better band at most once a minute', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-07T14:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const warn = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    const levels = [80, 75, 90, 120, 85, 130, 140];
    // first a WARNING-band account escalating to CALL must log at once (tested below)
    const accounts = { getAccountSummary: jest.fn(async () => ({ marginLevel: levels.shift() })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new StopOutService({ find: jest.fn() } as any, accounts as any, {} as any, {} as any, {} as any);

    await service.check('user-1'); // 80: MARGIN CALL logged
    await service.check('user-1'); // 75: same band within a minute, silent
    jest.setSystemTime(new Date('2026-10-07T14:01:01Z'));
    await service.check('user-1'); // 90: a minute later, logged again
    await service.check('user-1'); // 120: better band within a minute, silent
    await service.check('user-1'); // 85: same as the last logged band, silent
    jest.setSystemTime(new Date('2026-10-07T14:02:02Z'));
    await service.check('user-1'); // 130: better band, a minute later: logged
    await service.check('user-1'); // 140: same band within a minute, silent

    expect(warn.mock.calls.map(([m]) => String(m).split(' —')[0])).toEqual(['MARGIN CALL', 'MARGIN CALL', 'MARGIN WARNING']);
  });
});

describe('StopOutService alert escalation', () => {
  afterEach(() => jest.restoreAllMocks());
  it('logs an escalation from warning to margin call immediately', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const warn = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    const levels = [130, 95];
    const accounts = { getAccountSummary: jest.fn(async () => ({ marginLevel: levels.shift() })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new StopOutService({ find: jest.fn() } as any, accounts as any, {} as any, {} as any, {} as any);
    await service.check('user-1');
    await service.check('user-1');
    expect(warn.mock.calls.map(([m]) => String(m).split(' —')[0])).toEqual(['MARGIN WARNING', 'MARGIN CALL']);
  });
});

describe('StopOutService alerts around the warning threshold', () => {
  afterEach(() => jest.restoreAllMocks());
  it('a level hovering around 150% logs the warning once, not on every crossing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const warn = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    const levels = [149, 151, 148, 152, 147];
    const accounts = { getAccountSummary: jest.fn(async () => ({ marginLevel: levels.shift() })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new StopOutService({ find: jest.fn() } as any, accounts as any, {} as any, {} as any, {} as any);
    for (let i = 0; i < 5; i++) await service.check('user-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
