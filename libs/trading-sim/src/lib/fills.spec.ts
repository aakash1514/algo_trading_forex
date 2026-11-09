// Fills and SL/TP on real minutes: the traded M1 bars of Dukascopy EUR/USD on
// 2022-01-03 (the importer's verbatim fixture). Levels are taken from the bars
// themselves; no price is written by hand.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeQuote, entryFill, exitFill, exitQuotes, levelExit, pipPoints, priceToPoints } from './fills';
import { BidAskBar } from './types';

const FIXTURES = join(__dirname, '../../../../tools/market-data/import/src/fixtures');

// Decimal text -> integer points (string arithmetic, no float)
const points = (text: string, decimals: number) => {
  const [whole, fraction = ''] = text.split('.');
  return Number(whole + fraction.padEnd(decimals, '0'));
};

const eur: BidAskBar[] = readFileSync(join(FIXTURES, 'EURUSD-2022-01-03.csv'), 'utf8').split('\n').slice(1).filter(Boolean)
  .map((l) => l.split(','))
  .filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0)
  .map((c) => ({
    bid: { open: points(c[1], 5), high: points(c[2], 5), low: points(c[3], 5), close: points(c[4], 5) },
    ask: { open: points(c[6], 5), high: points(c[7], 5), low: points(c[8], 5), close: points(c[9], 5) },
  }));

const find = (predicate: (b: BidAskBar) => boolean) => {
  const bar = eur.find(predicate);
  if (!bar) throw new Error('no such minute in the fixture');
  return bar;
};

describe('fills on real bid/ask minutes', () => {
  it('uses real minutes', () => {
    expect(eur.length).toBeGreaterThan(1000);
  });

  it('opens a long at the ask open and a short at the bid open', () => {
    for (const bar of eur) {
      expect(entryFill('BUY', bar)).toBe(bar.ask.open);
      expect(entryFill('SELL', bar)).toBe(bar.bid.open);
    }
  });

  it('closes a long on the bid and a short on the ask, at the open or the close', () => {
    for (const bar of eur) {
      expect([exitFill('BUY', bar), closeQuote('BUY', bar), exitQuotes('BUY', bar)]).toEqual([bar.bid.open, bar.bid.close, bar.bid]);
      expect([exitFill('SELL', bar), closeQuote('SELL', bar), exitQuotes('SELL', bar)]).toEqual([bar.ask.open, bar.ask.close, bar.ask]);
    }
  });
});

describe('levelExit on real minutes', () => {
  it('returns null when neither level is touched', () => {
    const bar = find((b) => b.bid.high > b.bid.low);
    expect(levelExit('BUY', bar.bid.low - 1, bar.bid.high + 1, bar.bid)).toBeNull();
    expect(levelExit('SELL', bar.ask.high + 1, bar.ask.low - 1, bar.ask)).toBeNull();
    expect(levelExit('BUY', undefined, undefined, bar.bid)).toBeNull();
  });

  it('long: a stop touched inside the minute fills at the stop, a target at the target', () => {
    const bar = find((b) => b.bid.low < b.bid.open && b.bid.high > b.bid.open);
    expect(levelExit('BUY', bar.bid.low, undefined, bar.bid)).toEqual({ points: bar.bid.low, reason: 'STOP_LOSS' });
    expect(levelExit('BUY', undefined, bar.bid.high, bar.bid)).toEqual({ points: bar.bid.high, reason: 'TAKE_PROFIT' });
  });

  it('short: checked on the ask', () => {
    const bar = find((b) => b.ask.low < b.ask.open && b.ask.high > b.ask.open);
    expect(levelExit('SELL', bar.ask.high, undefined, bar.ask)).toEqual({ points: bar.ask.high, reason: 'STOP_LOSS' });
    expect(levelExit('SELL', undefined, bar.ask.low, bar.ask)).toEqual({ points: bar.ask.low, reason: 'TAKE_PROFIT' });
  });

  it('a minute that opens beyond a level fills at the open (gap)', () => {
    const bar = eur[600];
    expect(levelExit('BUY', bar.bid.open + 3, undefined, bar.bid)).toEqual({ points: bar.bid.open, reason: 'STOP_LOSS' });
    expect(levelExit('BUY', undefined, bar.bid.open - 3, bar.bid)).toEqual({ points: bar.bid.open, reason: 'TAKE_PROFIT' });
    expect(levelExit('SELL', bar.ask.open - 3, undefined, bar.ask)).toEqual({ points: bar.ask.open, reason: 'STOP_LOSS' });
    expect(levelExit('SELL', undefined, bar.ask.open + 3, bar.ask)).toEqual({ points: bar.ask.open, reason: 'TAKE_PROFIT' });
  });

  it('SL wins when SL and TP are both inside one minute', () => {
    const long = find((b) => b.bid.low < b.bid.open && b.bid.high > b.bid.open);
    expect(levelExit('BUY', long.bid.low, long.bid.high, long.bid)).toEqual({ points: long.bid.low, reason: 'STOP_LOSS' });
    const short = find((b) => b.ask.low < b.ask.open && b.ask.high > b.ask.open);
    expect(levelExit('SELL', short.ask.high, short.ask.low, short.ask)).toEqual({ points: short.ask.high, reason: 'STOP_LOSS' });
  });
});

describe('contract scale', () => {
  it('one pip is 10 points at every pair scale, and a fractional pip is rejected', () => {
    expect(pipPoints(0.0001, 5)).toBe(10);
    expect(pipPoints(0.01, 3)).toBe(10);
    expect(() => pipPoints(0.0001, 3)).toThrow('not a whole number of points');
  });

  it('rounds a price level once to the nearest point', () => {
    expect(priceToPoints(1.13726, 5)).toBe(113726);
    expect(priceToPoints(1812.805, 3)).toBe(1812805);
  });
});
