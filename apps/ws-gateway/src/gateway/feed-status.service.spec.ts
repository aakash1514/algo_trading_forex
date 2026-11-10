import { FeedStatusService } from './feed-status.service';

// Real tick shapes as ws-gateway receives them from forex.ticks (source, ISO timestamp)
const T0 = Date.parse('2026-11-10T12:00:00Z');
const at = (msAgo: number) => new Date(T0 - msAgo).toISOString();

function service(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    const s = new FeedStatusService();
    s.now = () => T0;
    return s;
  } finally {
    process.env = saved;
  }
}

describe('FeedStatusService', () => {
  it('MARKET_FEED unset (no feed): "none", with no tick', () => {
    expect(service({ MARKET_FEED: undefined }).status()).toEqual({ state: 'none', lastTickAgeMs: null });
  });

  it('MARKET_FEED=mock: "mock" even with a fresh tick, never live', () => {
    const s = service({ MARKET_FEED: 'mock' });
    s.tickReceived({ source: 'MOCK', timestamp: at(200) });
    expect(s.status()).toEqual({ state: 'mock', lastTickAgeMs: 200 });
  });

  it('keeps the newest tick when ticks of several pairs arrive out of order', () => {
    const s = service({ MARKET_FEED: 'mock' });
    s.tickReceived({ source: 'MOCK', timestamp: at(100) });
    s.tickReceived({ source: 'MOCK', timestamp: at(5_000) });
    s.tickReceived({ source: 'MOCK', timestamp: 'not a time' });
    expect(s.status().lastTickAgeMs).toBe(100);
  });

  it('a bad MARKET_FEED or FEED_LIVE_MAX_AGE_S fails at startup', () => {
    expect(() => service({ MARKET_FEED: 'oanda' })).toThrow('MARKET_FEED');
    expect(() => service({ FEED_LIVE_MAX_AGE_S: '0' })).toThrow('FEED_LIVE_MAX_AGE_S');
  });
});
