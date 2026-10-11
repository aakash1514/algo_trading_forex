// Trade-by-trade comparison of a backtester run (its results JSON, fetched through
// the API) with the independent SQL reproduction. Every field must match exactly:
// times as instants, prices as integer points, pips at 2 dp, money in whole cents,
// metrics at their stored scale. Empty input fails: a run or a reproduction with
// no bars or no trades proves nothing.

// The backtester's results.json (the fields compared)
export interface EngineResults {
  initialCapital: number;
  lots: number;
  units: number;
  finalEquity: number;
  dailyEquity: { time: string; equity: number }[];
  metrics: {
    totalTrades: number;
    winRate: number | null;
    profitFactor: number | null;
    sharpeRatio: number | null;
    maxDrawdownPct: number;
    totalPnl: number;
    totalPnlUsd: string;
  };
  trades: {
    action: 'BUY' | 'SELL';
    entryTime: string;
    exitTime: string;
    entryPoints: number;
    exitPoints: number;
    exitReason: string;
    pnl: number;
    netPnl: number;
    grossUsd: number;
    commissionUsd: number;
    netUsd: number;
  }[];
}

// The SQL's JSON document (ma-crossover.sql)
export interface SqlResults {
  bars: number;
  units: number | string;
  trades: {
    action: 'BUY' | 'SELL';
    entryTime: string;
    exitTime: string;
    entryPoints: number;
    exitPoints: number;
    exitReason: string;
    pips: number | string;
    netPips: number | string;
    grossCents: number | string;
    commissionCents: number | string;
    netCents: number | string;
  }[];
  metrics: {
    totalTrades: number;
    netCents: number | string;
    finalEquityCents: number | string;
    lastMarkCents: number | string;
    maxDrawdownPct: number | string | null;
    winRate: number | string | null;
    profitFactor: number | string | null;
    dailyCloses: number;
    sharpe: number | string | null;
  };
}

export interface Mismatch {
  where: string;   // 'trade 12' or 'metrics'
  field: string;
  engine: string;
  sql: string;
}

export interface Comparison {
  ok: boolean;
  errors: string[];        // structural failures (empty input, count mismatch)
  mismatches: Mismatch[];
  tradesCompared: number;
}

// Values normalised to exact strings at a fixed scale
const fixed = (v: number | string | null | undefined, dp: number): string =>
  v === null || v === undefined ? 'null' : Number(v).toFixed(dp);
const cents = (usd: number) => String(Math.round(usd * 100));
const instant = (t: string) => new Date(t).toISOString();

export function compareRuns(engine: EngineResults, sql: SqlResults): Comparison {
  const errors: string[] = [];
  const mismatches: Mismatch[] = [];
  if (!sql || sql.bars === 0) errors.push('the reproduction read no bars');
  if (!engine?.trades?.length) errors.push('the backtester returned no trades');
  if (!sql?.trades?.length) errors.push('the reproduction produced no trades');
  if (errors.length > 0) return { ok: false, errors, mismatches, tradesCompared: 0 };

  if (engine.trades.length !== sql.trades.length) {
    errors.push(`trade count differs: backtester ${engine.trades.length}, reproduction ${sql.trades.length}`);
  }
  const n = Math.min(engine.trades.length, sql.trades.length);
  for (let i = 0; i < n; i++) {
    const e = engine.trades[i];
    const s = sql.trades[i];
    const pairs: [string, string, string][] = [
      ['action', e.action, s.action],
      ['entryTime', instant(e.entryTime), instant(s.entryTime)],
      ['exitTime', instant(e.exitTime), instant(s.exitTime)],
      ['entryPoints', String(e.entryPoints), String(s.entryPoints)],
      ['exitPoints', String(e.exitPoints), String(s.exitPoints)],
      ['exitReason', e.exitReason, s.exitReason],
      ['pips', fixed(e.pnl, 2), fixed(s.pips, 2)],
      ['netPips', fixed(e.netPnl, 2), fixed(s.netPips, 2)],
      ['grossCents', cents(e.grossUsd), String(Number(s.grossCents))],
      ['commissionCents', cents(e.commissionUsd), String(Number(s.commissionCents))],
      ['netCents', cents(e.netUsd), String(Number(s.netCents))],
    ];
    for (const [field, a, b] of pairs) if (a !== b) mismatches.push({ where: `trade ${i + 1}`, field, engine: a, sql: b });
  }

  const m = engine.metrics;
  const sm = sql.metrics;
  const metricPairs: [string, string, string][] = [
    ['units', String(engine.units), String(Number(sql.units))],
    ['totalTrades', String(m.totalTrades), String(sm.totalTrades)],
    ['netCents', String(Math.round(Number(m.totalPnlUsd) * 100)), String(Number(sm.netCents))],
    ['finalEquityCents', cents(engine.finalEquity), String(Number(sm.finalEquityCents))],
    ['lastMarkCents', cents(engine.finalEquity), String(Number(sm.lastMarkCents))],
    ['maxDrawdownPct', fixed(m.maxDrawdownPct, 4), fixed(sm.maxDrawdownPct, 4)],
    ['winRate', fixed(m.winRate, 2), fixed(sm.winRate, 2)],
    ['profitFactor', fixed(m.profitFactor, 4), fixed(sm.profitFactor, 4)],
    ['dailyCloses', String(engine.dailyEquity.length), String(sm.dailyCloses)],
    ['sharpe', fixed(m.sharpeRatio, 4), fixed(sm.sharpe, 4)],
    ['totalPips', fixed(m.totalPnl, 2), fixed(sql.trades.reduce((a, t) => a + Number(t.netPips), 0), 2)],
  ];
  for (const [field, a, b] of metricPairs) if (a !== b) mismatches.push({ where: 'metrics', field, engine: a, sql: b });

  return { ok: errors.length === 0 && mismatches.length === 0, errors, mismatches, tradesCompared: n };
}
