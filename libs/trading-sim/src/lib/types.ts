// Prices are integer points: price x 10^priceDecimals, the scale fixed per pair in
// historical_price_scale (EUR/USD and GBP/USD 5, USD/JPY and XAU/USD 3).

export type Side = 'BUY' | 'SELL';

export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

// One bar (an M1 minute or an aggregate) with its own bid and ask OHLC in points
export interface BidAskBar {
  bid: Ohlc;
  ask: Ohlc;
}

export type LevelExitReason = 'STOP_LOSS' | 'TAKE_PROFIT';

export interface LevelExit {
  points: number;
  reason: LevelExitReason;
}
