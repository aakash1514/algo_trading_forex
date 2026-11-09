// The parser on the committed verified report (real backtest:verify output), and the
// comparison on its real trades.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareTrades, hourOf, ReplayedTrade } from './compare';
import { parseVerifiedReport, VerifiedTrade } from './verified-report';

const REPORT = readFileSync(join(__dirname, '../../../docs/validation/backtest-verification.md'), 'utf8');

// What replay reports for a verified trade when it matches: the fill minute is the
// bar's first minute, a strategy exit is a manual close, the end is SESSION_END on
// the last minute of the last bar
const asReplayed = (t: VerifiedTrade): ReplayedTrade => ({
  side: t.side, entryTime: `${t.entryHour}:00.000Z`, entryPoints: t.entryPoints,
  exitTime: t.exit === 'END_OF_DATA' ? `${t.exitHour.slice(0, 14)}59:00.000Z` : `${t.exitHour}:00.000Z`,
  exitPoints: t.exitPoints, exitReason: t.exit === 'END_OF_DATA' ? 'SESSION_END' : 'MANUAL', netCents: t.netCents,
});

describe('the verified report', () => {
  const run = parseVerifiedReport(REPORT);

  it('reads the run and every verified trade of the three pairs', () => {
    expect([run.fast, run.slow, run.from, run.to, run.lots, run.capital]).toEqual([10, 30, '2022-01-01', '2022-12-30', 0.1, 10000]);
    expect([...run.pairs.keys()]).toEqual(['EUR/USD', 'XAU/USD', 'USD/JPY']);
    expect([...run.pairs.values()].map((t) => t.length)).toEqual([257, 217, 215]);
    expect(run.pairs.get('EUR/USD')?.[0]).toEqual({
      n: 1, side: 'BUY', entryHour: '2022-01-05T09:00', entryPoints: 113030, exitHour: '2022-01-06T08:00', exitPoints: 112897,
      exit: 'SIGNAL', netCents: -1470,
    });
    // The report's totals: -272.20, -555.92, 1,485.75
    expect([...run.pairs.values()].map((t) => t.reduce((s, x) => s + x.netCents, 0))).toEqual([-27220, -55592, 148575]);
  });

  it('refuses a pair that was not verified, and a report without trades', () => {
    expect(() => parseVerifiedReport(REPORT.replace('All 257 trades and every metric match exactly.', 'Mismatches found.')))
      .toThrow('EUR/USD: the report does not say every trade matched');
    expect(() => parseVerifiedReport(REPORT.split('\n').filter((l) => !/^\| \d+ \|/.test(l)).join('\n'))).toThrow('0 trade rows');
    expect(() => parseVerifiedReport('# something else')).toThrow('not a backtest:verify report');
  });
});

describe('compareTrades', () => {
  const trades = parseVerifiedReport(REPORT).pairs.get('USD/JPY') as VerifiedTrade[];

  it('matches every trade replayed as verified', () => {
    const c = compareTrades(trades, trades.map(asReplayed));
    expect(c).toMatchObject({ ok: true, compared: 215, verifiedNetCents: 148575, replayedNetCents: 148575, mismatches: [], errors: [] });
  });

  it('floors a fill minute to its H1 bar (a bar whose first minute is missing)', () => {
    expect(hourOf('2022-01-05T09:01:00.000Z')).toBe('2022-01-05T09:00');
  });

  it('finds a cent, a point, a bar and a reason that differ', () => {
    const replayed = trades.map(asReplayed);
    replayed[3] = { ...replayed[3], netCents: replayed[3].netCents + 1 };
    replayed[10] = { ...replayed[10], entryPoints: replayed[10].entryPoints - 1 };
    replayed[20] = { ...replayed[20], exitTime: new Date(Date.parse(replayed[20].exitTime) + 3_600_000).toISOString() };
    replayed[30] = { ...replayed[30], exitReason: 'TP' };
    const c = compareTrades(trades, replayed);
    expect(c.ok).toBe(false);
    expect(c.mismatches.map((m) => [m.trade, m.field])).toEqual([
      [4, 'net cents'], [11, 'entry points'], [21, 'exit bar'], [31, 'exit reason'], [0, 'total net cents'],
    ]);
  });

  it('fails on empty input or a missing trade, never a match', () => {
    expect(compareTrades([], [])).toMatchObject({ ok: false, errors: ['no verified trades', 'no replayed trades'] });
    expect(compareTrades(trades, []).ok).toBe(false);
    expect(compareTrades(trades, trades.slice(1).map(asReplayed)).errors).toContain('215 verified trades, 214 replayed');
  });
});
