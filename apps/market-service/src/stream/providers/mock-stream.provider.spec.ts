import { isSpreadWide, marketStatus, spreadRatio } from '@forexedge/common';
import type { InstrumentQuoteSpec } from '../../market/instrument.repository';
import { MockStreamProvider, mockSpreadMultiplier, parseMockStreamWhenClosed } from './mock-stream.provider';

// pip_size and avg_spread exactly as stored in the instruments table.
const SPECS = new Map<string, InstrumentQuoteSpec>([
  ['EUR_USD', { pipSize: 0.0001, avgSpread: 0.0001, kind: 'MAJOR' }],
  ['GBP_USD', { pipSize: 0.0001, avgSpread: 0.00013, kind: 'MAJOR' }],
  ['USD_JPY', { pipSize: 0.01, avgSpread: 0.015, kind: 'MAJOR' }],
  ['XAU_USD', { pipSize: 0.01, avgSpread: 0.368, kind: 'METAL' }],
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
        // 21:30 UTC on this Wednesday is 17:30 New York: gold's daily break
        const kind = SPECS.get(instrument)?.kind ?? 'MAJOR';
        if (!marketStatus(kind, atUtcHour(hour)()).open) {
          expect(p.generateTick(instrument)).toBeNull();
          continue;
        }
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
    specs.set('USD_SGD', { pipSize: 0.0001, avgSpread: null, kind: 'EXOTIC' });
    const onTick = jest.fn();
    jest.useFakeTimers();
    const p = new MockStreamProvider(async () => specs, atUtcHour(14));
    await p.connect(['XAU_USD', 'USD_SGD', 'XAG_USD'], onTick, () => undefined);
    jest.advanceTimersByTime(500);
    await p.disconnect();
    jest.useRealTimers();
    expect(onTick.mock.calls.map(([t]) => t.instrument)).toEqual(['XAU_USD']);
  });

  describe('while a market is closed', () => {
    const at = (iso: string, streamWhenClosed = false) =>
      new MockStreamProvider(async () => SPECS, () => new Date(iso), Math.random, streamWhenClosed);

    it('sends no ticks for any instrument on the weekend', async () => {
      const p = at('2026-10-10T12:00:00Z'); // Saturday
      await p.connect([...SPECS.keys()], () => undefined, () => undefined);
      await p.disconnect();
      for (const instrument of SPECS.keys()) expect(p.generateTick(instrument)).toBeNull();
    });

    it("silences gold during its daily break while FX keeps ticking", async () => {
      const p = at('2026-10-12T21:30:00Z'); // Monday 17:30 New York
      await p.connect([...SPECS.keys()], () => undefined, () => undefined);
      await p.disconnect();
      expect(p.generateTick('XAU_USD')).toBeNull();
      expect(p.generateTick('EUR_USD')).not.toBeNull();
    });

    it('ticks around the clock with MOCK_STREAM_WHEN_CLOSED=true (development)', async () => {
      const p = at('2026-10-10T12:00:00Z', true);
      await p.connect([...SPECS.keys()], () => undefined, () => undefined);
      await p.disconnect();
      expect(p.generateTick('EUR_USD')).not.toBeNull();
    });

    it.each([[undefined, false], ['', false], ['false', false], ['true', true], [' TRUE ', true]])(
      'MOCK_STREAM_WHEN_CLOSED=%j -> %s', (raw, value) => expect(parseMockStreamWhenClosed(raw)).toBe(value));

    it('refuses any other MOCK_STREAM_WHEN_CLOSED value', () => {
      expect(() => parseMockStreamWhenClosed('yes')).toThrow('MOCK_STREAM_WHEN_CLOSED must be "true" or "false", got "yes"');
    });
  });
});
