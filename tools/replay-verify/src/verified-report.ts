// Reads the verified backtest trades from the report `npm run backtest:verify`
// writes (docs/validation/backtest-verification.md): the run's inputs, and per pair
// the trade table of a run that matched the independent SQL reproduction. A pair
// whose section doesn't say every trade matched is refused: only verified trades
// are replayed.

export interface VerifiedRun {
  fast: number;
  slow: number;
  from: string;     // YYYY-MM-DD, inclusive
  to: string;       // YYYY-MM-DD, inclusive
  lots: number;
  capital: number;  // USD
  pairs: Map<string, VerifiedTrade[]>; // 'EUR/USD' -> trades in order
}

export interface VerifiedTrade {
  n: number;
  side: 'BUY' | 'SELL';
  entryHour: string;   // the H1 bar it filled on, 'YYYY-MM-DDTHH:MM' UTC
  entryPoints: number;
  exitHour: string;
  exitPoints: number;
  exit: 'SIGNAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'END_OF_DATA';
  netCents: number;
}

const HEADER = /MA crossover (\d+)\/(\d+), H1, (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2}) \(inclusive, UTC\), ([\d.]+) lot, initial capital \$(\d+(?:\.\d+)?)\./;
const ROW = /^\| (\d+) \| (BUY|SELL) \| (\S+) \| (-?\d+) \| (\S+) \| (-?\d+) \| (SIGNAL|STOP_LOSS|TAKE_PROFIT|END_OF_DATA) \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| (-?\d+\.\d{2}) \|$/;

export function parseVerifiedReport(text: string): VerifiedRun {
  const header = HEADER.exec(text);
  if (!header) throw new Error('not a backtest:verify report (no run description)');
  const pairs = new Map<string, VerifiedTrade[]>();
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const pair = section.slice(0, section.indexOf('\n')).trim();
    const verified = /All (\d+) trades and every metric match exactly\./.exec(section);
    const trades = section.split('\n').map((l) => ROW.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        n: Number(m[1]), side: m[2] as VerifiedTrade['side'], entryHour: m[3], entryPoints: Number(m[4]),
        exitHour: m[5], exitPoints: Number(m[6]), exit: m[7] as VerifiedTrade['exit'],
        netCents: Math.round(Number(m[8]) * 100),
      }));
    if (!verified) throw new Error(`${pair}: the report does not say every trade matched; refusing to replay it`);
    if (trades.length === 0 || trades.length !== Number(verified[1])) {
      throw new Error(`${pair}: ${trades.length} trade rows, the report verified ${verified[1]}`);
    }
    trades.forEach((t, i) => {
      if (t.n !== i + 1) throw new Error(`${pair}: trade rows out of order at #${t.n}`);
    });
    pairs.set(pair, trades);
  }
  if (pairs.size === 0) throw new Error('the report has no pair sections');
  return {
    fast: Number(header[1]), slow: Number(header[2]), from: header[3], to: header[4],
    lots: Number(header[5]), capital: Number(header[6]), pairs,
  };
}
