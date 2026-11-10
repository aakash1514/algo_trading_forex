import {
  FEED_SOURCES, MAX_PRICE_AGE_MS, MarketFeed, feedDisplayState, lastTickAgeMs, parseFeedLiveMaxAgeMs, parseMarketFeed, priceProblem,
} from './market-feed';

// A real price value as market-service wrote it to Redis (price:last:EUR_USD, recorded 2026-10-10).
const RECORDED = {
  pair: 'EUR/USD', instrument: 'EUR_USD', bid: 1.08521, ask: 1.08533, mid: 1.08527, spread: 0.00012,
  timestamp: '2026-10-10T17:54:09.191Z', source: 'MOCK',
};
const AT = Date.parse(RECORDED.timestamp);

describe('parseMarketFeed', () => {
  it('defaults to no feed', () => {
    expect(parseMarketFeed(undefined)).toBe('none');
    expect(parseMarketFeed('')).toBe('none');
    expect(parseMarketFeed(' None ')).toBe('none');
  });

  it('enables the simulated feed only when asked explicitly', () => {
    expect(parseMarketFeed('mock')).toBe('mock');
  });

  it.each(['true', 'false', 'MOCK_DATA', 'twelvedata', 'yes'])('fails on %p instead of guessing', (raw) => {
    expect(() => parseMarketFeed(raw)).toThrow(/MARKET_FEED must be "none" or "mock"/);
  });
});

describe('priceProblem', () => {
  it('accepts a MOCK price up to its maximum age in mock mode', () => {
    expect(MAX_PRICE_AGE_MS.MOCK).toBe(2_000);
    expect(priceProblem('EUR/USD', RECORDED, 'mock', AT)).toBeNull();
    expect(priceProblem('EUR/USD', RECORDED, 'mock', AT + 2_000)).toBeNull();
  });

  it('rejects a stale price with its age, the maximum and the source', () => {
    expect(priceProblem('EUR/USD', RECORDED, 'mock', AT + 2_001)).toBe(
      'Price for EUR/USD is stale: last quote 2.1 s old (max 2 s, source MOCK)',
    );
    expect(priceProblem('EUR/USD', RECORDED, 'mock', AT + 412_000)).toBe(
      'Price for EUR/USD is stale: last quote 412 s old (max 2 s, source MOCK)',
    );
  });

  it('never trades a MOCK price unless the mock feed is configured', () => {
    expect(FEED_SOURCES.none).toEqual([]);
    expect(priceProblem('EUR/USD', RECORDED, 'none', AT)).toBe(
      'Price for EUR/USD comes from source MOCK, which the configured market feed (none) does not trade on',
    );
  });

  it('rejects sources with no configured feed or maximum age', () => {
    for (const source of ['TWELVE_DATA', 'OANDA', '']) {
      expect(priceProblem('EUR/USD', { ...RECORDED, source }, 'mock', AT)).toMatch(/does not trade on$/);
    }
  });

  it('rejects a missing or future timestamp', () => {
    expect(priceProblem('EUR/USD', { ...RECORDED, timestamp: 'not a date' }, 'mock', AT)).toBe(
      'Price for EUR/USD has no valid timestamp',
    );
    expect(priceProblem('EUR/USD', RECORDED, 'mock', AT - 5_000)).toBe(
      'Price for EUR/USD is stamped 5 s in the future (source MOCK)',
    );
    expect(priceProblem('EUR/USD', RECORDED, 'mock', AT - 1_000)).toBeNull();
  });
});

describe('feedDisplayState (the terminal status dot)', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const tick = (source: string, secondsAgo: number) => ({ source, timestamp: new Date(now - secondsAgo * 1000).toISOString() });
  // A future real provider: the type has only none/mock today, so the live branch is reached through a cast
  const real = 'oanda' as MarketFeed;

  it('MARKET_FEED=none is "none" whatever arrives', () => {
    expect(feedDisplayState('none', tick('OANDA', 0), now, 10_000)).toBe('none');
  });

  it('the simulator, or any MOCK tick, is "mock", never live', () => {
    expect(feedDisplayState('mock', tick('MOCK', 0), now, 10_000)).toBe('mock');
    expect(feedDisplayState(real, tick('MOCK', 0), now, 10_000)).toBe('mock');
  });

  it('a real feed is live only with a real tick within the maximum age', () => {
    expect(feedDisplayState(real, tick('OANDA', 10), now, 10_000)).toBe('live');
    expect(feedDisplayState(real, tick('OANDA', 10.001), now, 10_000)).toBe('stale');
    expect(feedDisplayState(real, null, now, 10_000)).toBe('stale');
    expect(feedDisplayState(real, tick('OANDA', -5), now, 10_000)).toBe('stale'); // stamped 5 s ahead
    expect(feedDisplayState(real, { source: 'OANDA', timestamp: 'garbage' }, now, 10_000)).toBe('stale');
  });

  it('FEED_LIVE_MAX_AGE_S: seconds, a positive whole number, default 10', () => {
    expect(parseFeedLiveMaxAgeMs(undefined)).toBe(10_000);
    expect(parseFeedLiveMaxAgeMs('30')).toBe(30_000);
    for (const bad of ['0', '-1', '1.5', 'ten']) expect(() => parseFeedLiveMaxAgeMs(bad)).toThrow('FEED_LIVE_MAX_AGE_S');
  });

  it('lastTickAgeMs', () => {
    expect(lastTickAgeMs(null, now)).toBeNull();
    expect(lastTickAgeMs(tick('MOCK', 3), now)).toBe(3_000);
  });
});
