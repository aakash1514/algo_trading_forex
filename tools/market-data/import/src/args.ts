import { FIRST_YEAR, LAST_YEAR, PAIRS } from './pairs';

// Bad command line: printed with the usage text
export class UsageError extends Error {}

export interface ImportArgs {
  years: number[];
  symbols: string[];
  // "EURUSD:2022" entries to re-import even though the log has them
  force: Set<string>;
  dryRun: boolean;
  checkOnly: boolean;
  check: boolean;
}

export const USAGE = `Usage: npm run data:import -- [options]
  --years 2010-2022      year or inclusive range (default ${FIRST_YEAR}-${LAST_YEAR})
  --pairs EURUSD,XAUUSD  comma-separated symbols (default all: ${Object.keys(PAIRS).join(',')})
  --force EURUSD:2022    re-import that pair-year (repeatable; it must be in --years/--pairs)
  --dry-run              stage and validate every file, write nothing
  --check-only           skip importing; run the real-data checks
  --no-check             skip the real-data checks after importing`;

export function forceKey(symbol: string, year: number): string {
  return `${symbol}:${year}`;
}

export function parseArgs(argv: string[]): ImportArgs {
  const args: ImportArgs = {
    years: range(FIRST_YEAR, LAST_YEAR),
    symbols: Object.keys(PAIRS),
    force: new Set(),
    dryRun: false,
    checkOnly: false,
    check: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--years': args.years = parseYears(value()); break;
      case '--pairs': args.symbols = parseSymbols(value()); break;
      case '--force': args.force.add(parseForce(value())); break;
      case '--dry-run': args.dryRun = true; break;
      case '--check-only': args.checkOnly = true; break;
      case '--no-check': args.check = false; break;
      default: throw new UsageError(`Unknown option ${flag}`);
    }
  }

  for (const key of args.force) {
    const [symbol, year] = key.split(':');
    if (!args.symbols.includes(symbol) || !args.years.includes(Number(year))) {
      throw new UsageError(`--force ${key} is outside --years/--pairs`);
    }
  }
  if (args.checkOnly && (args.dryRun || args.force.size > 0 || !args.check)) {
    throw new UsageError('--check-only cannot be combined with --dry-run, --force or --no-check');
  }
  return args;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function parseYear(text: string): number {
  if (!/^\d{4}$/.test(text)) throw new UsageError(`Invalid year "${text}"`);
  const year = Number(text);
  if (year < FIRST_YEAR || year > LAST_YEAR) {
    throw new UsageError(`Year ${year} is outside the exported range ${FIRST_YEAR}-${LAST_YEAR}`);
  }
  return year;
}

function parseYears(text: string): number[] {
  const [from, to = from] = text.split('-');
  const years = range(parseYear(from), parseYear(to));
  if (years.length === 0) throw new UsageError(`Empty year range "${text}"`);
  return years;
}

function parseSymbol(text: string): string {
  if (!(text in PAIRS)) throw new UsageError(`Unknown pair "${text}" (expected one of ${Object.keys(PAIRS).join(', ')})`);
  return text;
}

function parseSymbols(text: string): string[] {
  return [...new Set(text.split(',').map(parseSymbol))];
}

function parseForce(text: string): string {
  const [symbol, year, extra] = text.split(':');
  if (year === undefined || extra !== undefined) throw new UsageError(`--force expects PAIR:YEAR, got "${text}"`);
  return forceKey(parseSymbol(symbol), parseYear(year));
}
