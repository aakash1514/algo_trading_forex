import { MAJOR_PAIRS, PAIR_DISPLAY } from './constants';
import { getPipSize, getPriceDecimals } from './pip';

describe('tradable pairs', () => {
  it('are exactly the four pairs with imported history', () => {
    expect([...MAJOR_PAIRS]).toEqual(['EUR_USD', 'GBP_USD', 'USD_JPY', 'XAU_USD']);
    expect(Object.keys(PAIR_DISPLAY).sort()).toEqual([...MAJOR_PAIRS].sort());
  });

  // pip_size from the instruments rows; display names in the DB's slash format.
  it.each([
    ['EUR_USD', 'EUR/USD', 0.0001, 5],
    ['GBP_USD', 'GBP/USD', 0.0001, 5],
    ['USD_JPY', 'USD/JPY', 0.01, 3],
    ['XAU_USD', 'XAU/USD', 0.01, 3],
  ])('%s shows as %s with pip %d and %i price decimals', (pair, display, pip, decimals) => {
    expect(PAIR_DISPLAY[pair]).toBe(display);
    expect(getPipSize(pair)).toBe(pip);
    expect(getPriceDecimals(pair)).toBe(decimals);
  });
});
