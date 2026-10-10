import type { ConfigService } from '@nestjs/config';
import { MarketHoursPolicy, marketClosedReason, parseMarketHoursGate } from './market-hours.policy';

const config = (value?: string) => ({ get: () => value } as unknown as ConfigService);

describe('MARKET_HOURS_GATE', () => {
  it.each([[undefined, true], ['', true], ['true', true], [' TRUE ', true], ['false', false]])('%j -> enforced=%s', (raw, enforced) => {
    expect(parseMarketHoursGate(raw)).toBe(enforced);
  });

  it.each(['0', 'off', 'yes', 'flase'])('refuses %j instead of guessing', (raw) => {
    expect(() => parseMarketHoursGate(raw)).toThrow(`MARKET_HOURS_GATE must be "true" or "false", got "${raw}"`);
  });

  it('enforced: Saturday is closed; disabled: always open', () => {
    const saturday = new Date('2026-10-10T12:00:00Z');
    expect(new MarketHoursPolicy(config()).status('MAJOR', saturday)).toMatchObject({ open: false, reason: 'WEEKEND' });
    expect(new MarketHoursPolicy(config('false')).status('MAJOR', saturday)).toEqual({ open: true });
  });

  it('formats the rejection reason with the reopening time', () => {
    expect(marketClosedReason('EUR/USD', { open: false, reason: 'WEEKEND', reopensAt: new Date('2026-10-11T21:00:00Z') }))
      .toBe('Market closed for EUR/USD: weekend (reopens 2026-10-11 21:00 UTC)');
    expect(marketClosedReason('XAU/USD', { open: false, reason: 'DAILY_BREAK', reopensAt: new Date('2026-10-12T22:00:00Z') }))
      .toBe('Market closed for XAU/USD: daily break 17:00-18:00 New York (reopens 2026-10-12 22:00 UTC)');
  });
});
