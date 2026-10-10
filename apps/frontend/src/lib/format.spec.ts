import { formatSignedUsd } from './format';

describe('formatSignedUsd', () => {
  it.each([
    [38.46, '+$38.46'],
    [-20.99, '-$20.99'],
    [0, '+$0.00'],
    [-0.004, '+$0.00'], // rounds to zero: no "-$0.00"
    [-37.225, '-$37.23'],
    [1234.5, '+$1234.50'],
  ])('%d -> %s', (value, expected) => {
    expect(formatSignedUsd(value)).toBe(expected);
  });
});
