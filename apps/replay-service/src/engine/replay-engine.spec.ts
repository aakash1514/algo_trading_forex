// The replay engine on real minutes: Dukascopy EUR/USD 2022-01-03 (the importer's
// verbatim fixture). Positions are placed by the test; every price comes from the bars.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markToMarketCents, tradeMoney } from '@forexedge/trading-sim';
import { PairContext } from '../history/replay-history';
import { EngineMinute, EnginePosition, runMinute, unrealizedCents } from './replay-engine';

const FIXTURES = join(__dirname, '../../../../tools/market-data/import/src/fixtures');
const points = (text: string) => { const [w, f = ''] = text.split('.'); return Number(w + f.padEnd(5, '0')); };
const minutes: EngineMinute[] = readFileSync(join(FIXTURES, 'EURUSD-2022-01-03.csv'), 'utf8').split('\n').slice(1).filter(Boolean)
  .map((l) => l.split(',')).filter((c) => Number(c[5]) > 0 || Number(c[10]) > 0)
  .map((c) => ({
    time: new Date(Number(c[0])),
    bid: { open: points(c[1]), high: points(c[2]), low: points(c[3]), close: points(c[4]) },
    ask: { open: points(c[6]), high: points(c[7]), low: points(c[8]), close: points(c[9]) },
  }));

const EURUSD: PairContext = {
  pair: 'EUR/USD', priceDecimals: 5, pipSize: 0.0001, pipPoints: 10, lotSize: 100_000, maxLeverage: null,
  firstTime: minutes[0].time, lastTime: minutes[minutes.length - 1].time,
};
const money = { pair: 'EUR/USD', units: 10_000, priceDecimals: 5, pipPoints: 10 };

let ids = 0;
const order = (side: 'BUY' | 'SELL', over: Partial<EnginePosition> = {}): EnginePosition => ({
  id: `p${++ids}`, side, units: 10_000, status: 'PENDING', stopLossPoints: null, takeProfitPoints: null,
  entryTime: null, entryPoints: null, exitRequestedAt: null, exitTime: null, exitPoints: null, exitReason: null,
  realizedCents: null, ...over,
});
const find = (predicate: (m: EngineMinute) => boolean, from = 1) => {
  const i = minutes.findIndex((m, k) => k >= from && predicate(m));
  if (i < 0) throw new Error('no such minute in the fixture');
  return i;
};

describe('replay engine on real minutes', () => {
  it('uses real minutes', () => {
    expect(minutes.length).toBeGreaterThan(1000);
  });

  it('fills a pending order at the next minute open: BUY at the ask, SELL at the bid', () => {
    const buy = order('BUY');
    const sell = order('SELL');
    const m = minutes[100];
    expect(runMinute([buy, sell], m, EURUSD)).toEqual([
      { type: 'FILLED', positionId: buy.id, time: m.time, points: m.ask.open },
      { type: 'FILLED', positionId: sell.id, time: m.time, points: m.bid.open },
    ]);
    expect([buy.status, buy.entryTime, buy.entryPoints]).toEqual(['OPEN', m.time, m.ask.open]);
  });

  it('a requested close fills at the open, before new orders, at the backtester money', () => {
    const entry = minutes[200];
    const long = order('BUY', { status: 'OPEN', entryTime: entry.time, entryPoints: entry.ask.open, exitRequestedAt: minutes[300].time });
    const next = order('SELL');
    const m = minutes[301];
    const events = runMinute([next, long], m, EURUSD);
    expect(events.map((e) => [e.type, e.positionId])).toEqual([['CLOSED', long.id], ['FILLED', next.id]]);
    const net = tradeMoney({ action: 'BUY', entryPoints: entry.ask.open, exitPoints: m.bid.open }, money).netUsd;
    expect(long).toMatchObject({ status: 'CLOSED', exitReason: 'MANUAL', exitTime: m.time, exitPoints: m.bid.open });
    expect(long.realizedCents).toBe(BigInt(Math.round(net * 100)));
  });

  it('checks SL/TP on the fill minute itself, and fills a touched level at the level', () => {
    const i = find((m) => m.bid.low < m.bid.open && m.bid.high === m.bid.open);
    const m = minutes[i];
    const buy = order('BUY', { stopLossPoints: m.bid.low });
    const events = runMinute([buy], m, EURUSD);
    expect(events.map((e) => e.type)).toEqual(['FILLED', 'CLOSED']);
    expect(buy).toMatchObject({ status: 'CLOSED', exitReason: 'SL', exitPoints: m.bid.low, entryTime: m.time, exitTime: m.time });
  });

  it('a requested close fills at the open before the minute can reach the stop', () => {
    const i = find((m) => m.bid.low < m.bid.open);
    const m = minutes[i];
    const long = order('BUY', { status: 'OPEN', entryTime: minutes[i - 1].time, entryPoints: minutes[i - 1].ask.open,
      stopLossPoints: m.bid.low, exitRequestedAt: minutes[i - 1].time });
    runMinute([long], m, EURUSD);
    expect(long).toMatchObject({ exitReason: 'MANUAL', exitPoints: m.bid.open });
  });

  it('SL first when SL and TP are both inside one minute (long on the bid, short on the ask)', () => {
    const i = find((m) => m.bid.low < m.bid.open && m.bid.high > m.bid.open);
    const m = minutes[i];
    const long = order('BUY', { status: 'OPEN', entryTime: minutes[i - 1].time, entryPoints: minutes[i - 1].ask.open,
      stopLossPoints: m.bid.low, takeProfitPoints: m.bid.high });
    runMinute([long], m, EURUSD);
    expect(long).toMatchObject({ exitReason: 'SL', exitPoints: m.bid.low });

    const j = find((x) => x.ask.low < x.ask.open && x.ask.high > x.ask.open);
    const n = minutes[j];
    const short = order('SELL', { status: 'OPEN', entryTime: minutes[j - 1].time, entryPoints: minutes[j - 1].bid.open,
      stopLossPoints: n.ask.high, takeProfitPoints: n.ask.low });
    runMinute([short], n, EURUSD);
    expect(short).toMatchObject({ exitReason: 'SL', exitPoints: n.ask.high });
  });

  it('a gap through the take profit fills at the open', () => {
    const m = minutes[500];
    const long = order('BUY', { status: 'OPEN', entryTime: minutes[499].time, entryPoints: minutes[499].ask.open,
      takeProfitPoints: m.bid.open - 2 });
    runMinute([long], m, EURUSD);
    expect(long).toMatchObject({ exitReason: 'TP', exitPoints: m.bid.open });
  });

  it('an untouched position stays open, and unrealized P&L is the mark to market at the close', () => {
    const entry = minutes[700];
    const long = order('BUY', { status: 'OPEN', entryTime: entry.time, entryPoints: entry.ask.open });
    const short = order('SELL', { status: 'OPEN', entryTime: entry.time, entryPoints: entry.bid.open });
    const m = minutes[701];
    expect(runMinute([long, short], m, EURUSD)).toEqual([]);
    expect(unrealizedCents([long, short], m, EURUSD)).toBe(
      markToMarketCents('BUY', entry.ask.open, m.bid.close, money) + markToMarketCents('SELL', entry.bid.open, m.ask.close, money));
  });
});
