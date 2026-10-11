// The comparison on real trades: the first two MA crossover (10/30) trades of
// EUR/USD 2022 H1 at 0.1 lot, as the reproduction SQL returns them from the
// imported Dukascopy history (entry/exit points are real H1 bid/ask opens).
import { compareRuns, EngineResults, SqlResults } from './compare';

const sqlTrades: SqlResults['trades'] = [
  { action: 'BUY', entryTime: '2022-01-05T09:00:00+00:00', exitTime: '2022-01-06T08:00:00+00:00', entryPoints: 113030,
    exitPoints: 112897, exitReason: 'SIGNAL', pips: -13.3, netPips: -14.7, grossCents: -1330, commissionCents: 140, netCents: -1470 },
  { action: 'SELL', entryTime: '2022-01-06T08:00:00+00:00', exitTime: '2022-01-07T10:00:00+00:00', entryPoints: 112897,
    exitPoints: 113153, exitReason: 'SIGNAL', pips: -25.6, netPips: -27, grossCents: -2560, commissionCents: 140, netCents: -2700 },
];

const sql = (): SqlResults => ({
  bars: 6240, units: 10000, trades: sqlTrades.map((t) => ({ ...t })),
  metrics: { totalTrades: 2, netCents: -4170, finalEquityCents: 995830, lastMarkCents: 995830, maxDrawdownPct: 0.6, winRate: 0,
    profitFactor: 0, dailyCloses: 3, sharpe: -11.1111 },
});

const engine = (): EngineResults => ({
  initialCapital: 10_000, lots: 0.1, units: 10_000, finalEquity: 9958.3,
  dailyEquity: [{ time: '', equity: 0 }, { time: '', equity: 0 }, { time: '', equity: 0 }],
  metrics: { totalTrades: 2, winRate: 0, profitFactor: 0, sharpeRatio: -11.1111, maxDrawdownPct: 0.6, totalPnl: -41.7, totalPnlUsd: '-41.70' },
  trades: sqlTrades.map((t) => ({
    action: t.action, entryTime: new Date(t.entryTime).toISOString(), exitTime: new Date(t.exitTime).toISOString(),
    entryPoints: t.entryPoints, exitPoints: t.exitPoints, exitReason: t.exitReason, pnl: Number(t.pips), netPnl: Number(t.netPips),
    grossUsd: Number(t.grossCents) / 100, commissionUsd: Number(t.commissionCents) / 100, netUsd: Number(t.netCents) / 100,
  })),
});

describe('compareRuns', () => {
  it('passes when every trade and metric matches (times compared as instants)', () => {
    expect(compareRuns(engine(), sql())).toEqual({ ok: true, errors: [], mismatches: [], tradesCompared: 2 });
  });

  it('fails on empty input from either side', () => {
    expect(compareRuns({ ...engine(), trades: [] }, sql()))
      .toMatchObject({ ok: false, errors: ['the backtester returned no trades'] });
    expect(compareRuns(engine(), { ...sql(), trades: [] }))
      .toMatchObject({ ok: false, errors: ['the reproduction produced no trades'] });
    expect(compareRuns(engine(), { ...sql(), bars: 0 }))
      .toMatchObject({ ok: false, errors: ['the reproduction read no bars'] });
  });

  it('fails on a single cent, naming the trade and field', () => {
    const e = engine();
    e.trades[1].netUsd = -27.01;
    expect(compareRuns(e, sql())).toMatchObject({
      ok: false, mismatches: [{ where: 'trade 2', field: 'netCents', engine: '-2701', sql: '-2700' }],
    });
  });

  it('fails on a one-point price or a one-bar time difference', () => {
    const s = sql();
    s.trades[0].exitPoints = 112898;
    s.trades[1].entryTime = '2022-01-06T09:00:00+00:00';
    const fields = compareRuns(engine(), s).mismatches.map((m) => `${m.where} ${m.field}`);
    expect(fields).toEqual(['trade 1 exitPoints', 'trade 2 entryTime']);
  });

  it('fails when the trade counts differ', () => {
    const s = sql();
    s.trades.pop();
    expect(compareRuns(engine(), s).errors).toEqual(['trade count differs: backtester 2, reproduction 1']);
  });

  it('fails on a metric difference at its stored scale', () => {
    const s = sql();
    s.metrics.sharpe = -11.1112;
    expect(compareRuns(engine(), s).mismatches).toEqual([{ where: 'metrics', field: 'sharpe', engine: '-11.1111', sql: '-11.1112' }]);
  });
});
