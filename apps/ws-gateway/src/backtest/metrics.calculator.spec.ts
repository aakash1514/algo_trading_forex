// Money metrics on real bars only:
//  - USD/JPY: five consecutive real H1 bars, read with
//      SELECT bucket, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close
//      FROM historical_candles_1h WHERE pair = 'USD/JPY'
//        AND bucket BETWEEN '2022-03-01 08:00Z' AND '2022-03-01 12:00Z' ORDER BY bucket;
//  - EUR/USD: the traded M1 minutes of the importer's verbatim fixtures
//    2012-12-31 12:00 .. 2013-01-02 12:00 (three New York closes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  calculateMetrics, dailyEquityCents, equityAtBarCloses, maxDrawdownPct, newYorkClose, newYorkCloses, TRADING_DAYS_PER_YEAR,
} from './metrics.calculator';
import { MoneySpec, positionUnits, tradeMoney } from '@forexedge/trading-sim';
import { TradeSimulator } from './trade.simulator';
import { Candle, MoneyTrade, Signal } from './strategies/strategy.interface';

const ohlc = (o: number, h: number, l: number, c: number) => ({ open: o, high: h, low: l, close: c });
const bar = (ms: number, b: number[], a: number[]): Candle =>
  ({ bucket: new Date(ms), bid: ohlc(b[0], b[1], b[2], b[3]), ask: ohlc(a[0], a[1], a[2], a[3]), minutes: 60, open: 0, high: 0, low: 0, close: 0 });

const usdjpy: Candle[] = [
  bar(1646121600000, [115032, 115064, 114920, 114926], [115037, 115068, 114923, 114929]), // 08:00
  bar(1646125200000, [114926, 114957, 114745, 114778], [114929, 114961, 114748, 114781]), // 09:00
  bar(1646128800000, [114778, 114888, 114771, 114858], [114780, 114892, 114773, 114863]), // 10:00
  bar(1646132400000, [114857, 114861, 114744, 114805], [114860, 114866, 114749, 114809]), // 11:00
  bar(1646136000000, [114805, 114877, 114713, 114824], [114809, 114880, 114715, 114828]), // 12:00
];

const FIXTURES = join(__dirname, '../../../../tools/market-data/import/src/fixtures');
const points = (text: string) => { const [w, f = ''] = text.split('.'); return Number(w + f.padEnd(5, '0')); };
const eur: Candle[] = ['EURUSD-2012-12-31-pm.csv', 'EURUSD-2013-01-01-to-02-noon.csv']
  .flatMap((file) => readFileSync(join(FIXTURES, file), 'utf8').split('\n').slice(1).filter(Boolean))
  .map((l) => l.split(',')).filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0)
  .map((c) => ({
    bucket: new Date(Number(c[0])), minutes: 1, open: 0, high: 0, low: 0, close: 0,
    bid: ohlc(points(c[1]), points(c[2]), points(c[3]), points(c[4])),
    ask: ohlc(points(c[6]), points(c[7]), points(c[8]), points(c[9])),
  }));

const signal = (b: Candle, action: Signal['action']): Signal => ({ timestamp: b.bucket, action, lots: 0.1, reason: 'test' });
function simulate(candles: Candle[], signals: Signal[], money: MoneySpec, decimals: number): MoneyTrade[] {
  return new TradeSimulator({ pipSize: decimals === 5 ? 0.0001 : 0.01, priceDecimals: decimals })
    .simulate(candles, signals).map((t) => ({ ...t, ...tradeMoney(t, money) }));
}

describe('New York closes', () => {
  it('is 17:00 New York in UTC, across the DST switch', () => {
    expect(newYorkClose(2022, 1, 3).toISOString()).toBe('2022-01-03T22:00:00.000Z');
    expect(newYorkClose(2022, 3, 11).toISOString()).toBe('2022-03-11T22:00:00.000Z'); // Friday, EST
    expect(newYorkClose(2022, 3, 14).toISOString()).toBe('2022-03-14T21:00:00.000Z'); // Monday after the switch, EDT
    expect(newYorkClose(2022, 11, 7).toISOString()).toBe('2022-11-07T22:00:00.000Z'); // back to EST
  });

  it('takes Monday-Friday from the calendar (holidays included, weekends never)', () => {
    const closes = newYorkCloses(new Date('2022-12-24T00:00Z'), new Date('2023-01-01T00:00Z'));
    expect(closes.map((c) => c.toISOString().slice(0, 10)))
      .toEqual(['2022-12-26', '2022-12-27', '2022-12-28', '2022-12-29', '2022-12-30']);
  });
});

describe('equity marked to market (USD/JPY, real H1 bars)', () => {
  const money: MoneySpec = { pair: 'USD/JPY', units: positionUnits(0.1, 100_000), priceDecimals: 3, pipPoints: 10 };
  // BUY after 08:00 -> fills at the 09:00 ask open 114929; CLOSE_LONG after 11:00 -> the 12:00 bid open 114805
  const trades = simulate(usdjpy, [signal(usdjpy[0], 'BUY'), signal(usdjpy[3], 'CLOSE_LONG')], money, 3);

  it('values the open long at each bid close, converted at that close, commission deducted', () => {
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ entryPoints: 114929, exitPoints: 114805, grossUsd: -10.8, netUsd: -12.02, commissionUsd: 1.22 });
    // 09:00 close 114778: (114778 - 114929 - 14) x 10,000 x 100 / 114778 = -1437.56 -> -1438 cents
    // 10:00 close 114858: -85 points -> -740.04 -> -740;  11:00 close 114805: -138 -> -1202.04 -> -1202
    // 12:00: closed at the open 114805 -> realized -1202 cents
    expect(equityAtBarCloses({ candles: usdjpy, trades, money, initialCapital: 10_000 }))
      .toEqual([1_000_000n, 998_562n, 999_260n, 998_798n, 998_798n]);
  });

  it('max drawdown is the worst marked equity against the peak', () => {
    const { metrics, finalEquity } = calculateMetrics({
      candles: usdjpy, trades, money, initialCapital: 10_000, barMs: 3_600_000,
      window: { from: new Date('2022-03-01T00:00Z'), end: new Date('2022-03-02T00:00Z') },
    });
    expect(metrics).toMatchObject({ maxDrawdownPct: 0.1438, totalPnlUsd: '-12.02', winRate: 0, profitFactor: 0, totalTrades: 1 });
    expect(finalEquity).toBe(9987.98);
  });
});

describe('daily series and Sharpe (EUR/USD, real M1 bars over three New York closes)', () => {
  const money: MoneySpec = { pair: 'EUR/USD', units: positionUnits(0.1, 100_000), priceDecimals: 5, pipPoints: 10 };
  const window = { from: new Date('2012-12-31T00:00Z'), end: new Date('2013-01-03T00:00Z') };
  const at = (iso: string) => eur.find((c) => c.bucket.toISOString() === iso) as Candle;
  const signals = [
    signal(at('2012-12-31T14:00:00.000Z'), 'BUY'), signal(at('2013-01-01T23:00:00.000Z'), 'CLOSE_LONG'),
    signal(at('2013-01-02T03:00:00.000Z'), 'SELL'), // still open at the end of the data: closed at the last close
  ];
  const trades = simulate(eur, signals, money, 5);
  const input = { candles: eur, trades, money, initialCapital: 10_000, barMs: 60_000, window };

  it('uses real bars and real trades', () => {
    expect(eur.length).toBeGreaterThan(500);
    expect(trades.map((t) => t.exitReason)).toEqual(['SIGNAL', 'END_OF_DATA']);
  });

  it('samples equity at the last bar closing at or before each close', () => {
    const curve = equityAtBarCloses(input);
    const closes = newYorkCloses(window.from, window.end);
    expect(closes.map((c) => c.toISOString())).toEqual(['2012-12-31T22:00:00.000Z', '2013-01-01T22:00:00.000Z', '2013-01-02T22:00:00.000Z']);
    const daily = dailyEquityCents(eur, curve, closes, 60_000, 1_000_000n);
    const lastBefore = (close: Date) => {
      const idx = eur.map((c) => c.bucket.getTime() + 60_000 <= close.getTime()).lastIndexOf(true);
      return curve[idx];
    };
    expect(daily).toEqual(closes.map(lastBefore));
    // New Year's Day has no traded minute before its close: its sample is the last
    // bar of 2012-12-31 (22:15), so the holiday is a 0-return day
    expect(eur.filter((c) => c.bucket >= new Date('2013-01-01T00:00Z') && c.bucket < new Date('2013-01-01T22:00Z'))).toEqual([]);
    expect(daily[1]).toBe(curve[eur.findIndex((c) => c.bucket.toISOString() >= '2013-01-01') - 1]);
    expect(daily[2]).toBe(curve[curve.length - 1]); // the data ends at 2013-01-02 11:59
  });

  it('Sharpe = mean / sample stdev of the daily returns x sqrt(260); final equity = capital + net USD', () => {
    const { metrics, dailyEquity, finalEquity } = calculateMetrics(input);
    const e = [10_000, ...dailyEquity.map((d) => d.equity)];
    const r = e.slice(1).map((v, i) => v / e[i] - 1);
    const mean = r.reduce((a, x) => a + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1));
    expect(r).toHaveLength(3);
    expect(metrics.sharpeRatio).toBeCloseTo((mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR), 4);
    const net = trades.reduce((a, t) => a + Math.round(t.netUsd * 100), 0);
    expect(finalEquity).toBe((1_000_000 + net) / 100);
    expect(metrics.totalPnlUsd).toBe((net / 100).toFixed(2));
    // USD-quoted at 0.1 lot: $1 per pip
    expect(Number(metrics.totalPnlUsd)).toBe(metrics.totalPnl);
  });

  it('max drawdown matches a brute-force scan of the marked curve', () => {
    const curve = equityAtBarCloses(input).map(Number);
    let peak = 1_000_000;
    let worst = 0;
    for (const v of curve) { peak = Math.max(peak, v); worst = Math.max(worst, (peak - v) / peak * 100); }
    expect(worst).toBeGreaterThan(0);
    expect(maxDrawdownPct(1_000_000n, equityAtBarCloses(input))).toBeCloseTo(worst, 4);
  });

  it('with no trades: flat equity, drawdown 0, and null where a ratio is undefined', () => {
    const result = calculateMetrics({ ...input, trades: [] });
    expect(result.metrics).toEqual({
      totalTrades: 0, winRate: null, profitFactor: null, sharpeRatio: null, maxDrawdownPct: 0, totalPnl: 0, totalPnlUsd: '0.00',
    });
    expect(result.dailyEquity.map((d) => d.equity)).toEqual([10_000, 10_000, 10_000]);
  });
});
