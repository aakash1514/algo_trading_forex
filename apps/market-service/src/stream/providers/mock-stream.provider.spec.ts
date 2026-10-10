import { isSpreadWide, spreadRatio } from '@forexedge/common';
import type { InstrumentQuoteSpec } from '../../market/instrument.repository';
import { MockStreamProvider, mockSpreadMultiplier } from './mock-stream.provider';

// pip_size and avg_spread exactly as stored in the instruments table.
const SPECS = new Map<string, InstrumentQuoteSpec>([
  ['EUR_USD', { pipSize: 0.0001, avgSpread: 0.0001 }],
  ['GBP_USD', { pipSize: 0.0001, avgSpread: 0.00013 }],
  ['USD_JPY', { pipSize: 0.01, avgSpread: 0.015 }],
  ['XAU_USD', { pipSize: 0.01, avgSpread: 0.368 }],
]);

// Lookups that fail loudly instead of non-null assertions
function avgSpreadOf(instrument: string): number {
  const avg = SPECS.get(instrument)?.avgSpread;
  if (avg == null) throw new Error(`no avg_spread fixture for ${instrument}`);
  return avg;
}
function pipSizeOf(instrument: string): number {
  const spec = SPECS.get(instrument);
  if (!spec) throw new Error(`no spec fixture for ${instrument}`);
  return spec.pipSize;
}
function tickOf(p: MockStreamProvider, instrument: string) {
  const tick = p.generateTick(instrument);
  if (!tick) throw new Error(`no tick for ${instrument}`);
  return tick;
}

const atUtcHour = (hour: number) => () => new Date(Date.UTC(2026, 9, 7, hour, 30)); // a Wednesday

async function provider(hour: number) {
  // Deterministic uniforms for the random walk
  let seed = 42;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const p = new MockStreamProvider(async () => SPECS, atUtcHour(hour), random);
  await p.connect([...SPECS.keys()], () => undefined, () => undefined);
  await p.disconnect(); // only generateTick is exercised
  return p;
}

describe('MockStreamProvider quotes', () => {
  const instruments = [...SPECS.keys()];
  const sydneyOnly = [22, 23];

  it.each(Array.from({ length: 24 }, (_, h) => h).filter((h) => !sydneyOnly.includes(h)))(
    'at %i:30 UTC the spread is avg_spread x the session multiplier (<= 1.5x) and never WIDE',
    async (hour) => {
      const p = await provider(hour);
      for (const instrument of instruments) {
        const pipSize = pipSizeOf(instrument);
        const avgSpread = avgSpreadOf(instrument);
        for (let i = 0; i < 50; i++) {
          const tick = tickOf(p, instrument);
          const ratio = spreadRatio(tick.bid, tick.ask, avgSpread);
          // Within half a quoted point of the exact multiple (GBP/USD's 0.00013 x 1.5
          // = 0.000195 falls between two points), plus the ratio's 4 dp rounding
          expect(Math.abs(ratio - mockSpreadMultiplier(hour))).toBeLessThanOrEqual(pipSize / 10 / avgSpread / 2 + 0.0001);
          expect(ratio).toBeGreaterThanOrEqual(1);
          expect(ratio).toBeLessThanOrEqual(1.5 + 0.04);
          expect(isSpreadWide(ratio)).toBe(false);
        }
      }
    },
  );

  it('is exactly 1x the average during the London/New York overlap', async () => {
    const p = await provider(14);
    for (const instrument of instruments) {
      const tick = tickOf(p, instrument);
      expect(spreadRatio(tick.bid, tick.ask, avgSpreadOf(instrument))).toBe(1);
    }
  });

  it.each(sydneyOnly)('at %i:30 UTC (Sydney only) the spread doubles but stays on the 2x limit, not WIDE', async (hour) => {
    const p = await provider(hour);
    for (const instrument of instruments) {
      for (let i = 0; i < 50; i++) {
        const tick = tickOf(p, instrument);
        const ratio = spreadRatio(tick.bid, tick.ask, avgSpreadOf(instrument));
        expect(ratio).toBe(2);
        expect(isSpreadWide(ratio)).toBe(false);
      }
    }
  });

  it('quotes gold at 3 decimals from its last real close, and FX at their pip precision', async () => {
    const p = await provider(14);
    const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
    const gold = tickOf(p, 'XAU_USD');
    expect(gold).toMatchObject({ pair: 'XAU/USD', instrument: 'XAU_USD', source: 'MOCK' });
    expect(decimals(gold.bid)).toBeLessThanOrEqual(3);
    expect(decimals(gold.ask)).toBeLessThanOrEqual(3);
    expect(gold.bid).toBeGreaterThan(1700); // random walk around 1823.86
    expect(gold.bid).toBeLessThan(1950);
    expect(decimals(tickOf(p, 'EUR_USD').bid)).toBeLessThanOrEqual(5);
    expect(decimals(tickOf(p, 'USD_JPY').bid)).toBeLessThanOrEqual(3);
  });

  it('skips instruments without a base price or avg_spread instead of inventing one', async () => {
    const specs = new Map(SPECS);
    specs.set('USD_SGD', { pipSize: 0.0001, avgSpread: null });
    const onTick = jest.fn();
    jest.useFakeTimers();
    const p = new MockStreamProvider(async () => specs, atUtcHour(14));
    await p.connect(['XAU_USD', 'USD_SGD', 'XAG_USD'], onTick, () => undefined);
    jest.advanceTimersByTime(500);
    await p.disconnect();
    jest.useRealTimers();
    expect(onTick.mock.calls.map(([t]) => t.instrument)).toEqual(['XAU_USD']);
  });
});
