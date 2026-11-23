import { roundHalfAway } from './replay-stats';

// The one rounding rule of every statistic: half away from zero, as Postgres round(numeric)
describe('roundHalfAway', () => {
  it.each([
    [5n, 2n, 3n], [-5n, 2n, -3n], [4n, 3n, 1n], [-4n, 3n, -1n], [5n, 3n, 2n], [-5n, 3n, -2n], [6n, 3n, 2n], [0n, 7n, 0n],
  ])('%s / %s -> %s', (n, d, expected) => {
    expect(roundHalfAway(n, d)).toBe(expected);
  });
});
