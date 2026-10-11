import { finalEquityUsd, formatMetric, formatPips, formatUsd, inclusiveToHint, returnPct } from './backtest';

describe('backtest display helpers', () => {
  it('derives final equity and return from the decimal strings, in cents', () => {
    expect(finalEquityUsd('10000.00', '-272.20')).toBe(9727.8);
    expect(finalEquityUsd('10000.00', '0.10')).toBe(10000.1);
    expect(returnPct('10000.00', '-272.20')).toBeCloseTo(-2.722, 10);
  });

  it('formats USD with thousands separators', () => {
    expect(formatUsd(9727.8)).toBe('$9,727.80');
    expect(formatUsd(10_000)).toBe('$10,000.00');
  });

  it('shows null metrics as a dash, never 0', () => {
    expect(formatMetric(null, 2)).toBe('—');
    expect(formatMetric('-0.2542', 2)).toBe('-0.25');
    expect(formatMetric('10.5612', 1, '%')).toBe('10.6%');
    expect(formatPips(null)).toBe('—');
    expect(formatPips('-272.20')).toBe('-272.2 pips');
    expect(formatPips('13.30')).toBe('+13.3 pips');
  });

  it('spells out the inclusive To day in UTC', () => {
    expect(inclusiveToHint('2022-12-30')).toBe('Includes all of 30 Dec 2022 (UTC)');
    expect(inclusiveToHint('')).toBe('');
  });
});
