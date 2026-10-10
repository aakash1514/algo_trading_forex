// TradeSimulator on real bars: the traded M1 minutes of Dukascopy EUR/USD and
// XAU/USD on 2022-01-03 (the importer's verbatim fixtures). Only the signals are
// written by hand; prices always come from the bars.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Candle, Signal, StrategyContext } from './strategies/strategy.interface';
import { TradeSimulator } from './trade.simulator';

const FIXTURES = join(__dirname, '../../../../tools/market-data/import/src/fixtures');

// Decimal text -> integer points (string arithmetic, no float)
const points = (text: string, decimals: number) => {
  const [whole, fraction = ''] = text.split('.');
  return Number(whole + fraction.padEnd(decimals, '0'));
};

function realBars(file: string, decimals: number): Candle[] {
  return readFileSync(join(FIXTURES, file), 'utf8').split('\n').slice(1).filter(Boolean)
    .map((l) => l.split(','))
    .filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0)
    .map((c) => {
      const bid = { open: points(c[1], decimals), high: points(c[2], decimals), low: points(c[3], decimals), close: points(c[4], decimals) };
      const ask = { open: points(c[6], decimals), high: points(c[7], decimals), low: points(c[8], decimals), close: points(c[9], decimals) };
      const mid = (b: number, a: number) => (b + a) / 2 / 10 ** decimals;
      return {
        bucket: new Date(Number(c[0])), bid, ask, minutes: 1,
        open: mid(bid.open, ask.open), high: mid(bid.high, ask.high), low: mid(bid.low, ask.low), close: mid(bid.close, ask.close),
      };
    });
}

const EURUSD: StrategyContext = { pipSize: 0.0001, priceDecimals: 5 };
const XAUUSD: StrategyContext = { pipSize: 0.01, priceDecimals: 3 };
const eur = realBars('EURUSD-2022-01-03.csv', 5);
const xau = realBars('XAUUSD-2022-01-03.csv', 3);
const price = (pts: number, d = 5) => pts / 10 ** d;
const signal = (bar: Candle, action: Signal['action'], extra: Partial<Signal> = {}): Signal =>
  ({ timestamp: bar.bucket, action, lots: 0.1, reason: 'test', ...extra });

describe('TradeSimulator on real bid/ask bars', () => {
  it('uses real bars', () => {
    expect(eur.length).toBeGreaterThan(1000);
    expect(xau.length).toBeGreaterThan(1000);
  });

  it('fills a signal at the NEXT bar open: buy at the ask, close a long at the bid', () => {
    const [trade] = new TradeSimulator(EURUSD).simulate(eur, [signal(eur[100], 'BUY'), signal(eur[200], 'CLOSE_LONG')]);
    expect(trade).toMatchObject({
      action: 'BUY', exitReason: 'SIGNAL',
      entryTime: eur[101].bucket, entryPrice: price(eur[101].ask.open),
      exitTime: eur[201].bucket, exitPrice: price(eur[201].bid.open),
      pnl: (eur[201].bid.open - eur[101].ask.open) / 10, commission: 1.4,
    });
  });

  it('sells at the bid open and buys back at the ask open', () => {
    const [trade] = new TradeSimulator(EURUSD).simulate(eur, [signal(eur[300], 'SELL'), signal(eur[360], 'CLOSE_SHORT')]);
    expect(trade).toMatchObject({
      action: 'SELL', entryPrice: price(eur[301].bid.open), exitPrice: price(eur[361].ask.open),
      pnl: (eur[301].bid.open - eur[361].ask.open) / 10,
    });
  });

  it('reverses at one open: the close runs before the new entry', () => {
    const trades = new TradeSimulator(EURUSD).simulate(eur,
      [signal(eur[400], 'SELL'), signal(eur[450], 'CLOSE_SHORT'), signal(eur[450], 'BUY'), signal(eur[500], 'CLOSE_LONG')]);
    expect(trades.map((t) => [t.action, t.exitTime, t.entryTime])).toEqual([
      ['SELL', eur[451].bucket, eur[401].bucket],
      ['BUY', eur[501].bucket, eur[451].bucket],
    ]);
    expect(trades[1].entryPrice).toBe(price(eur[451].ask.open));
  });

  it('checks SL/TP on the fill bar itself, after its open, and fills a touched level at the level', () => {
    const i = eur.findIndex((b, k) => k > 0 && b.bid.low < b.bid.open && b.bid.high === b.bid.open);
    expect(i).toBeGreaterThan(0);
    const fill = eur[i];
    const [trade] = new TradeSimulator(EURUSD).simulate(eur, [signal(eur[i - 1], 'BUY', { stopLoss: price(fill.bid.low) })]);
    expect(trade).toMatchObject({ entryTime: fill.bucket, exitTime: fill.bucket, exitReason: 'STOP_LOSS', exitPrice: price(fill.bid.low) });
  });

  it('fills at the open when a bar opens beyond the stop (gap)', () => {
    const fill = eur[601];
    const stop = price(fill.bid.open + 3); // already through the stop at the open
    const [trade] = new TradeSimulator(EURUSD).simulate(eur, [signal(eur[600], 'BUY', { stopLoss: stop })]);
    expect(trade).toMatchObject({ exitTime: fill.bucket, exitReason: 'STOP_LOSS', exitPrice: price(fill.bid.open) });
  });

  it('takes the stop when SL and TP are both inside one bar', () => {
    const i = eur.findIndex((b, k) => k > 0 && b.bid.low < b.bid.open && b.bid.high > b.bid.open);
    const fill = eur[i];
    const [trade] = new TradeSimulator(EURUSD).simulate(eur,
      [signal(eur[i - 1], 'BUY', { stopLoss: price(fill.bid.low), takeProfit: price(fill.bid.high) })]);
    expect(trade).toMatchObject({ exitTime: fill.bucket, exitReason: 'STOP_LOSS', exitPrice: price(fill.bid.low) });
  });

  it('tests a short against the ask', () => {
    const i = eur.findIndex((b, k) => k > 0 && b.ask.low < b.ask.open && b.ask.high === b.ask.open);
    const fill = eur[i];
    const [trade] = new TradeSimulator(EURUSD).simulate(eur, [signal(eur[i - 1], 'SELL', { takeProfit: price(fill.ask.low) })]);
    expect(trade).toMatchObject({ exitReason: 'TAKE_PROFIT', exitPrice: price(fill.ask.low), entryPrice: price(fill.bid.open) });
  });

  it('never fills a signal on the last bar, and closes an open trade at the last close', () => {
    const last = eur[eur.length - 1];
    expect(new TradeSimulator(EURUSD).simulate(eur, [signal(last, 'BUY')])).toEqual([]);
    const [trade] = new TradeSimulator(EURUSD).simulate(eur, [signal(eur[eur.length - 10], 'SELL')]);
    expect(trade).toMatchObject({ exitReason: 'END_OF_DATA', exitTime: last.bucket, exitPrice: price(last.ask.close) });
  });

  it('counts gold pips at 3 decimals (pip 0.01 = 10 points)', () => {
    const [trade] = new TradeSimulator(XAUUSD).simulate(xau, [signal(xau[50], 'BUY'), signal(xau[90], 'CLOSE_LONG')]);
    expect(trade.pnl).toBe((xau[91].bid.open - xau[51].ask.open) / 10);
    expect(trade.entryPrice).toBe(xau[51].ask.open / 1000);
  });

  it('rejects a pip size that is not a whole number of points', () => {
    expect(() => new TradeSimulator({ pipSize: 0.0001, priceDecimals: 3 })).toThrow('not a whole number of points');
  });
});
