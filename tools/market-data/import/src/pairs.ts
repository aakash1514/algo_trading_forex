// The pairs the JForex export delivers (data/raw/jforex/<SYMBOL>/<YEAR>.csv) and the
// DB pair each one is stored as. Adding a pair also needs its historical_price_scale row.
export const PAIRS: Readonly<Record<string, string>> = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  XAUUSD: 'XAU/USD',
};

export const FIRST_YEAR = 2010;
export const LAST_YEAR = 2022;

export interface TimeRange {
  start: Date; // inclusive
  end: Date;   // exclusive
}

export function yearRange(year: number): TimeRange {
  return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year + 1, 0, 1)) };
}

export const MINUTE_MS = 60_000;
