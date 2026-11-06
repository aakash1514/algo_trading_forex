import { FEED_SOURCES, MAX_PRICE_AGE_MS, parseMarketFeed, priceProblem } from './market-feed';

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
