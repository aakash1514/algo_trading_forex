import { backtestWindow, parseDay } from './backtest-window';

// Bucket starts below are real EUR/USD bars from the imported history
// (historical_candles_1h/_4h/_1d, June 2022: New York 17:00 = 21:00 UTC in EDT).
const inWindow = (buckets: string[], w: ReturnType<typeof backtestWindow>) =>
  buckets.map((b) => new Date(b)).filter((b) => b >= w.from && b <= w.lastBucket).map((b) => b.toISOString());

describe('parseDay', () => {
  it('maps a calendar day to its 00:00 UTC', () => {
    expect(parseDay('2022-12-30').toISOString()).toBe('2022-12-30T00:00:00.000Z');
    expect(parseDay('2020-02-29').toISOString()).toBe('2020-02-29T00:00:00.000Z');
  });

  it.each(['2022-02-30', '2021-02-29', '2022-13-01', '2022-12-30T00:00:00Z', '2022-12-30 ', '30/12/2022', ''])(
    'rejects %p instead of normalising it', (day) => {
      expect(() => parseDay(day)).toThrow('is not a calendar date');
    });
});

describe('backtestWindow: both days inclusive, whole bars only', () => {
  it('ends at the next midnight UTC; the To day is part of the window', () => {
    const w = backtestWindow('2022-01-01', '2022-12-30', '1h');
    expect(w.from.toISOString()).toBe('2022-01-01T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2022-12-31T00:00:00.000Z');
    expect(w.days).toBe(364);
  });

  it('H1: the 23:00 bar of the To day is the last bar', () => {
    const w = backtestWindow('2022-06-15', '2022-06-15', '1h');
    expect(w.lastBucket.toISOString()).toBe('2022-06-15T23:00:00.000Z');
    expect(w.days).toBe(1);
  });

  it('M1: the 23:59 bar of the To day is the last bar', () => {
    expect(backtestWindow('2022-06-15', '2022-06-15', '1m').lastBucket.toISOString()).toBe('2022-06-15T23:59:00.000Z');
  });

  it('D1 (NY close): the bar ending at the To day 17:00 NY is in, the one starting that evening is out', () => {
    const d1 = ['2022-06-13T21:00:00Z', '2022-06-14T21:00:00Z', '2022-06-15T21:00:00Z', '2022-06-16T21:00:00Z'];
    expect(inWindow(d1, backtestWindow('2022-06-14', '2022-06-15', '1d'))).toEqual(['2022-06-14T21:00:00.000Z']);
  });

  it('H4 (NY-aligned): the bar spanning midnight after the To day is out', () => {
    const h4 = ['2022-06-14T13:00:00Z', '2022-06-14T17:00:00Z', '2022-06-14T21:00:00Z', '2022-06-15T01:00:00Z', '2022-06-15T05:00:00Z'];
    expect(inWindow(h4, backtestWindow('2022-06-14', '2022-06-14', '4h')))
      .toEqual(['2022-06-14T13:00:00.000Z', '2022-06-14T17:00:00.000Z']);
  });

  it('rejects From after To and a non-calendar day', () => {
    expect(() => backtestWindow('2022-06-16', '2022-06-15', '1h')).toThrow('is after toDate');
    expect(() => backtestWindow('2022-06-15', '2022-06-31', '1h')).toThrow('is not a calendar date');
  });
});
