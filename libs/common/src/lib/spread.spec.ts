import { SPREAD_WIDE_RATIO, isSpreadWide, spreadRatio } from './spread';

describe('spread rule', () => {
  // avg_spread values are the instruments rows: EUR/USD 0.0001, XAU/USD 0.368
  // (median 2022 Dukascopy spread), both price differences like ask - bid.
  it.each([
    ['1.99x', 1.08500, 1.085199, 0.0001, 1.99, false],
    ['2.0x', 1.08500, 1.08520, 0.0001, 2, false],
    ['2.01x', 1.08500, 1.085201, 0.0001, 2.01, true],
    ['gold at its average', 1823.463, 1823.831, 0.368, 1, false],
    ['gold at 2.01x', 1823.463, 1824.20268, 0.368, 2.01, true],
  ])('%s', (_label, bid, ask, avg, ratio, wide) => {
    expect(spreadRatio(bid, ask, avg)).toBe(ratio);
    expect(isSpreadWide(spreadRatio(bid, ask, avg))).toBe(wide);
  });

  it('treats exactly 2x as not wide even when ask - bid carries float noise', () => {
    // A gold spread of exactly 2 x 0.368 is 2.000000000000282 on doubles: a
    // strict "> 2" on the raw value would call it WIDE.
    expect((1824.199 - 1823.463) / 0.368).toBeGreaterThan(SPREAD_WIDE_RATIO);
    expect(spreadRatio(1823.463, 1824.199, 0.368)).toBe(2);
    expect(isSpreadWide(spreadRatio(1823.463, 1824.199, 0.368))).toBe(false);

    // The noise also goes the other way (EUR/USD 2x is 1.9999999999997797).
    expect((1.0852 - 1.085) / 0.0001).toBeLessThan(SPREAD_WIDE_RATIO);
    expect(spreadRatio(1.085, 1.0852, 0.0001)).toBe(2);
  });

  it.each([0, -0.0001, NaN])('refuses a non-positive average spread (%p)', (avg) => {
    expect(() => spreadRatio(1.085, 1.0851, avg)).toThrow('avg_spread must be a positive price difference');
  });
});
