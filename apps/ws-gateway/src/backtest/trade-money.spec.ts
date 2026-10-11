// Money on real trades. Prices are real H1 bid/ask opens from the imported
// Dukascopy history, in integer points, read with:
//   SELECT pair, bucket, bid_open, ask_open FROM historical_candles_1h
//   WHERE (pair, bucket) IN (('EUR/USD','2022-01-05 09:00Z'), ('EUR/USD','2022-01-06 08:00Z'),
//     ('XAU/USD','2022-01-04 17:00Z'), ('XAU/USD','2022-01-06 02:00Z'),
//     ('USD/JPY','2022-03-01 09:00Z'), ('USD/JPY','2022-03-02 15:00Z'));
// Lot sizes are the instruments rows (100,000 for FX, 100 oz for XAU/USD).
// EUR/USD and XAU/USD are trades #1 and #4 of the step-2 backtest proof; the
// USD/JPY trade is an illustration on real bars, not a strategy output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commissionPoints, MoneySpec, pointsToUsdCents, positionUnits, roundHalfAwayFromZero, tradeMoney, usdLeg,
} from './trade-money';
import { TradeSimulator } from './trade.simulator';
import { Candle } from './strategies/strategy.interface';

const spec = (pair: string, lots: number, lotSize: number, priceDecimals: number): MoneySpec =>
  ({ pair, units: positionUnits(lots, lotSize), priceDecimals, pipPoints: 10 });

describe('trade money (USD) on real trades', () => {
  it('USD-quoted: EUR/USD BUY 0.1 lot, ask open 113030 -> bid open 112897', () => {
    expect(tradeMoney({ action: 'BUY', entryPoints: 113030, exitPoints: 112897 }, spec('EUR/USD', 0.1, 100_000, 5)))
      .toEqual({ units: 10_000, grossUsd: -13.3, commissionUsd: 1.4, netUsd: -14.7 });
  });

  it('XAU: XAU/USD BUY 0.1 lot (10 oz), ask open 1812805 -> bid open 1810068', () => {
    expect(tradeMoney({ action: 'BUY', entryPoints: 1812805, exitPoints: 1810068 }, spec('XAU/USD', 0.1, 100, 3)))
      .toEqual({ units: 10, grossUsd: -27.37, commissionUsd: 0.14, netUsd: -27.51 });
  });

  it('JPY: USD/JPY BUY 0.1 lot, ask open 114929 -> bid open 115471, converted at the exit fill', () => {
    // gross 542 points x 10,000 / 115,471 = 46.938...; net 528 x 10,000 / 115,471 = 45.7258...
    expect(tradeMoney({ action: 'BUY', entryPoints: 114929, exitPoints: 115471 }, spec('USD/JPY', 0.1, 100_000, 3)))
      .toEqual({ units: 10_000, grossUsd: 46.94, commissionUsd: 1.21, netUsd: 45.73 });
  });

  it('JPY short: the same bars sold and bought back convert at the exit (ask) fill', () => {
    // SELL at the bid open 114926, buy back at the ask open 115474: -548 - 14 = -562 points
    expect(tradeMoney({ action: 'SELL', entryPoints: 114926, exitPoints: 115474 }, spec('USD/JPY', 0.1, 100_000, 3)))
      .toEqual({ units: 10_000, grossUsd: -47.46, commissionUsd: 1.21, netUsd: -48.67 });
  });

  it('commission is 0.7 pip per side: 14 points', () => {
    expect(commissionPoints(10)).toBe(14);
  });
});

describe('rounding: half away from zero, from the exact fraction', () => {
  it.each([
    [5n, 2n, 3n], [-5n, 2n, -3n], [7n, 3n, 2n], [-7n, 3n, -2n], [8n, 3n, 3n], [-8n, 3n, -3n], [0n, 7n, 0n],
  ])('%p / %p -> %p', (n, d, expected) => {
    expect(roundHalfAwayFromZero(n, d)).toBe(expected);
  });

  it('a negative USD/JPY amount rounds away from zero like Postgres round(numeric)', () => {
    // -562 x 10,000 x 100 / 115,474 = -4866.89... -> -4867 cents
    expect(pointsToUsdCents(-562, spec('USD/JPY', 0.1, 100_000, 3), 115474)).toBe(-4867n);
  });
});

describe('contract checks', () => {
  it('units are lots x lot size and must be whole', () => {
    expect(positionUnits(0.01, 100)).toBe(1);
    expect(positionUnits(0.1, 100_000)).toBe(10_000);
    expect(() => positionUnits(0.001, 100)).toThrow('is not a whole, positive number of units');
  });

  it('a pair without a USD leg is rejected rather than valued at a guessed rate', () => {
    expect(usdLeg('EUR/USD')).toBe('quote');
    expect(usdLeg('USD/JPY')).toBe('base');
    expect(() => usdLeg('EUR/GBP')).toThrow('has no USD leg');
  });
});

describe('simulated trades on real M1 bars', () => {
  const FIXTURES = join(__dirname, '../../../../tools/market-data/import/src/fixtures');
  const points = (text: string) => { const [w, f = ''] = text.split('.'); return Number(w + f.padEnd(5, '0')); };
  const eur: Candle[] = readFileSync(join(FIXTURES, 'EURUSD-2022-01-03.csv'), 'utf8').split('\n').slice(1).filter(Boolean)
    .map((l) => l.split(',')).filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0)
    .map((c) => {
      const bid = { open: points(c[1]), high: points(c[2]), low: points(c[3]), close: points(c[4]) };
      const ask = { open: points(c[6]), high: points(c[7]), low: points(c[8]), close: points(c[9]) };
      return { bucket: new Date(Number(c[0])), bid, ask, minutes: 1, open: 0, high: 0, low: 0, close: 0 };
    });

  it('EUR/USD at 0.1 lot: net USD is exactly net pips x $1 for every trade', () => {
    const at = (i: number) => eur[i].bucket;
    const trades = new TradeSimulator({ pipSize: 0.0001, priceDecimals: 5 }).simulate(eur, [
      { timestamp: at(100), action: 'BUY', lots: 0.1, reason: 'test' }, { timestamp: at(400), action: 'CLOSE_LONG', lots: 0.1, reason: 'test' },
      { timestamp: at(500), action: 'SELL', lots: 0.1, reason: 'test' }, { timestamp: at(900), action: 'CLOSE_SHORT', lots: 0.1, reason: 'test' },
    ]);
    expect(trades).toHaveLength(2);
    for (const t of trades) {
      const m = tradeMoney(t, spec('EUR/USD', 0.1, 100_000, 5));
      expect([m.grossUsd, m.netUsd]).toEqual([t.pnl, t.netPnl]);
      expect(t.entryPoints / 1e5).toBe(t.entryPrice);
    }
  });
});
