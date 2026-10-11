// Spread rule shared by domain-service (spread alerts) and order-service (the
// order gate), so the two can never disagree about what "too wide" means.
//
// The comparison is relative to the instrument's typical spread
// (instruments.avg_spread, a price difference like the spread itself), which
// works across asset classes: a 0.37 gold spread and a 0.0001 EUR/USD spread
// are both "1x normal". A fixed pip limit cannot do that.

// A spread is WIDE when it is strictly more than twice the instrument's average.
// Strictly greater: the mock feed doubles spreads in its Sydney-only hours,
// which lands exactly on 2x and must not flap between NORMAL and WIDE.
export const SPREAD_WIDE_RATIO = 2;

// ask - bid on doubles carries binary noise (2x can come out as
// 2.0000000000000462), so ratios are compared at 4 decimal places.
const RATIO_DECIMALS = 4;

export function spreadRatio(bid: number, ask: number, avgSpread: number): number {
  if (!(avgSpread > 0)) {
    throw new Error(`avg_spread must be a positive price difference, got ${avgSpread}`);
  }
  const f = 10 ** RATIO_DECIMALS;
  return Math.round(((ask - bid) / avgSpread) * f) / f;
}

export function isSpreadWide(ratio: number): boolean {
  return ratio > SPREAD_WIDE_RATIO;
}
