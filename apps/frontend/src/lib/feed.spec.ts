import { feedBanner, MAX_PRICE_AGE_MS, NO_FEED_MESSAGE, orderEntry, priceState, SIMULATED_MESSAGE } from './feed';
import type { FeedStatus } from '../types/api.types';
import noneStatus from '../components/trading/__fixtures__/feed-status-none.json';
import mockStatus from '../components/trading/__fixtures__/feed-status-mock.json';
import recordedTick from '../components/trading/__fixtures__/tick-eurusd-mock.json';

// Real responses (components/trading/__fixtures__/README.md)
const NONE = noneStatus as FeedStatus;
const MOCK = mockStatus as FeedStatus;
// No degraded/down status has been recorded (the simulator never fails): the recorded mock status with
// only its state changed.
const withState = (state: FeedStatus['state']): FeedStatus => ({ ...MOCK, state });
const TICK_AT = Date.parse(recordedTick.timestamp);

describe('priceState', () => {
  it('is fresh up to the source maximum, then stale; none without a price', () => {
    expect(MAX_PRICE_AGE_MS.MOCK).toBe(2_000);
    expect(priceState(recordedTick, TICK_AT + 2_000)).toBe('fresh');
    expect(priceState(recordedTick, TICK_AT + 2_001)).toBe('stale');
    expect(priceState(undefined, TICK_AT)).toBe('none');
  });

  it('treats a source without a maximum age as never tradable', () => {
    expect(priceState({ ...recordedTick, source: 'TWELVE_DATA' }, TICK_AT)).toBe('stale');
  });
});

describe('feedBanner', () => {
  it('says there is no live feed by default', () => {
    expect(feedBanner(NONE, false)).toEqual({ tone: 'neutral', text: NO_FEED_MESSAGE });
    expect(NO_FEED_MESSAGE).toBe('No live market feed — historical Replay mode is coming');
  });

  it('marks simulated prices as not market data', () => {
    const banner = feedBanner(MOCK, false);
    expect(banner?.tone).toBe('simulated');
    expect(banner?.text).toContain(SIMULATED_MESSAGE);
    expect(SIMULATED_MESSAGE).toBe('SIMULATED PRICES — not market data');
  });

  it('warns when the feed is failing or its status is unavailable', () => {
    expect(feedBanner(withState('degraded'), false)?.text).toMatch(/^Market feed degraded: prices are stale/);
    expect(feedBanner(withState('down'), false)?.text).toMatch(/^Market feed down/);
    expect(feedBanner(undefined, true)?.tone).toBe('warning');
    expect(feedBanner(undefined, false)).toBeNull(); // still loading
  });
});

describe('orderEntry', () => {
  const fresh = TICK_AT + 500;

  it('is disabled with no feed, saying there is no live price', () => {
    expect(orderEntry(NONE, false, 'EUR/USD', undefined, fresh)).toEqual({
      enabled: false, label: 'Paper trade', reason: 'No live price for EUR/USD',
    });
  });

  it('allows paper trades on a fresh simulated price, and says they are simulated', () => {
    expect(orderEntry(MOCK, false, 'EUR/USD', recordedTick, fresh)).toEqual({
      enabled: true, label: 'Paper trade on simulated prices', reason: null,
    });
  });

  it('is disabled on a stale or missing price, a failing feed, or an unknown status', () => {
    expect(orderEntry(MOCK, false, 'EUR/USD', recordedTick, TICK_AT + 60_000).reason).toBe('Price for EUR/USD is stale');
    expect(orderEntry(MOCK, false, 'EUR/USD', undefined, fresh).reason).toBe('No live price for EUR/USD');
    expect(orderEntry(withState('down'), false, 'EUR/USD', recordedTick, fresh).reason).toBe('Market feed down: no fresh prices');
    expect(orderEntry(undefined, true, 'EUR/USD', recordedTick, fresh).reason).toBe('Market feed status unavailable');
  });
});
