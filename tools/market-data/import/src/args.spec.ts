import { parseArgs, UsageError } from './args';

describe('parseArgs', () => {
  it('defaults to every pair and 2010-2022', () => {
    const args = parseArgs([]);
    expect(args.symbols).toEqual(['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']);
    expect(args.years[0]).toBe(2010);
    expect(args.years[args.years.length - 1]).toBe(2022);
    expect(args.years).toHaveLength(13);
    expect(args).toMatchObject({ dryRun: false, checkOnly: false, check: true });
    expect(args.force.size).toBe(0);
  });

  it('parses years, pairs and repeated --force', () => {
    const args = parseArgs(['--years', '2021-2022', '--pairs', 'EURUSD,XAUUSD', '--force', 'EURUSD:2022',
      '--force', 'XAUUSD:2021', '--no-check']);
    expect(args.years).toEqual([2021, 2022]);
    expect(args.symbols).toEqual(['EURUSD', 'XAUUSD']);
    expect([...args.force]).toEqual(['EURUSD:2022', 'XAUUSD:2021']);
    expect(args.check).toBe(false);
  });

  it('accepts a single year', () => {
    expect(parseArgs(['--years', '2022']).years).toEqual([2022]);
  });

  it.each([
    [['--years', '2009-2010'], 'outside the exported range'],
    [['--years', '2023'], 'outside the exported range'],
    [['--years', '2022-2021'], 'Empty year range'],
    [['--years', '22'], 'Invalid year'],
    [['--pairs', 'EURGBP'], 'Unknown pair'],
    [['--force', 'EURUSD'], 'expects PAIR:YEAR'],
    [['--force', 'EURUSD:2022', '--years', '2021'], 'outside --years/--pairs'],
    [['--force', 'GBPUSD:2022', '--pairs', 'EURUSD'], 'outside --years/--pairs'],
    [['--check-only', '--dry-run'], 'cannot be combined'],
    [['--years'], 'needs a value'],
    [['--years', '--dry-run'], 'needs a value'],
    [['--apply'], 'Unknown option'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
