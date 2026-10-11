// MA crossover on real bars: the traded M1 minutes of Dukascopy EUR/USD on
// 2022-01-03 (the importer's verbatim fixture).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Candle, IStrategy, StrategyContext } from './strategy.interface';
import { MovingAverageCrossoverStrategy } from './ma-crossover.strategy';

const FIXTURES = join(__dirname, '../../../../../tools/market-data/import/src/fixtures');
const points = (text: string) => { const [w, f = ''] = text.split('.'); return Number(w + f.padEnd(5, '0')); };

const eur: Candle[] = readFileSync(join(FIXTURES, 'EURUSD-2022-01-03.csv'), 'utf8').split('\n').slice(1).filter(Boolean)
  .map((l) => l.split(',')).filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0)
  .map((c) => {
    const bid = { open: points(c[1]), high: points(c[2]), low: points(c[3]), close: points(c[4]) };
    const ask = { open: points(c[6]), high: points(c[7]), low: points(c[8]), close: points(c[9]) };
    const mid = (b: number, a: number) => (b + a) / 2 / 1e5;
    return {
      bucket: new Date(Number(c[0])), bid, ask, minutes: 1,
      open: mid(bid.open, ask.open), high: mid(bid.high, ask.high), low: mid(bid.low, ask.low), close: mid(bid.close, ask.close),
    };
  });
const EURUSD: StrategyContext = { pipSize: 0.0001, priceDecimals: 5 };
const strategy: IStrategy = new MovingAverageCrossoverStrategy();
const at = (iso: string) => eur.findIndex((c) => c.bucket.toISOString() === iso);

// Reference: SMA_fast vs SMA_slow as exact fractions (BigInt cross-multiplication
// of the doubled mid sums), independent of the strategy's prefix sums
function exactSide(i: number, fast: number, slow: number): number {
  const sum = (p: number) => eur.slice(i - p + 1, i + 1).reduce((a, c) => a + BigInt(c.bid.close + c.ask.close), 0n);
  const d = sum(fast) * BigInt(slow) - sum(slow) * BigInt(fast);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

describe('MA crossover: exact SMAs from integer mid sums', () => {
  it('uses real bars', () => {
    expect(eur.length).toBe(1425);
  });

  it('an exact tie is not a cross: SMA5 = SMA20 at 12:47, so the cross below is at 12:48', () => {
    // 2022-01-03 12:47: sum5 = 1,135,041 and sum20 = 4,540,164 doubled-mid points;
    // 1,135,041 x 20 = 4,540,164 x 5 = 22,700,820. Float SMAs put fast below slow
    // here (one bar early); the exact comparison waits for 12:48.
    const tie = at('2022-01-03T12:47:00.000Z');
    expect(exactSide(tie - 1, 5, 20)).toBe(1);
    expect(exactSide(tie, 5, 20)).toBe(0);
    expect(exactSide(tie + 1, 5, 20)).toBe(-1);
    const floatSma = (i: number, p: number) => eur.slice(i - p + 1, i + 1).reduce((a, c) => a + c.close, 0) / p;
    expect(floatSma(tie, 5) < floatSma(tie, 20)).toBe(true); // the float near-tie this avoids

    const sells = strategy.generate(eur, { fastPeriod: 5, slowPeriod: 20, lots: 0.1 }, EURUSD)
      .filter((s) => s.action === 'SELL').map((s) => s.timestamp.toISOString());
    expect(sells).toContain('2022-01-03T12:48:00.000Z');
    expect(sells).not.toContain('2022-01-03T12:47:00.000Z');
  });

  it.each([[10, 30], [5, 20], [3, 9]])('signals match the exact-fraction reference on every bar (%i/%i)', (fast, slow) => {
    const expected: string[] = [];
    let position: 'LONG' | 'SHORT' | null = null;
    for (let i = slow; i < eur.length; i++) {
      const prev = exactSide(i - 1, fast, slow);
      const now = exactSide(i, fast, slow);
      const t = eur[i].bucket.toISOString();
      if (prev <= 0 && now > 0 && position !== 'LONG') {
        if (position === 'SHORT') expected.push(`${t} CLOSE_SHORT`);
        expected.push(`${t} BUY`);
        position = 'LONG';
      }
      if (prev >= 0 && now < 0 && position !== 'SHORT') {
        if (position === 'LONG') expected.push(`${t} CLOSE_LONG`);
        expected.push(`${t} SELL`);
        position = 'SHORT';
      }
    }
    const signals = strategy.generate(eur, { fastPeriod: fast, slowPeriod: slow, lots: 0.1 }, EURUSD);
    expect(expected.length).toBeGreaterThan(0);
    expect(signals.map((s) => `${s.timestamp.toISOString()} ${s.action}`)).toEqual(expected);
  });

  it('returns no signals without enough bars, and rejects non-integer periods', () => {
    expect(strategy.generate(eur.slice(0, 30), { fastPeriod: 10, slowPeriod: 30 }, EURUSD)).toEqual([]);
    expect(() => strategy.generate(eur, { fastPeriod: 10.5, slowPeriod: 30 }, EURUSD)).toThrow('positive integers');
  });
});
