import { centsToDecimal, decimalToCents } from './booking';

describe('exact cents <-> NUMERIC(14,2)', () => {
  it.each([
    [0n, '0.00'], [5n, '0.05'], [-5n, '-0.05'], [123456n, '1234.56'], [-27251n, '-272.51'], [1000000n, '10000.00'],
  ])('%p cents <-> %p', (cents, text) => {
    expect(centsToDecimal(cents)).toBe(text);
    expect(decimalToCents(text)).toBe(cents);
  });

  it('reads the forms Postgres returns', () => {
    expect(decimalToCents('10000')).toBe(1000000n);
    expect(decimalToCents('9727.8')).toBe(972780n);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '1.234', '1e5']) expect(() => decimalToCents(bad)).toThrow('not a 2-decimal amount');
  });
});
