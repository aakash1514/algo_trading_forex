import { getPipSize, getPriceDecimals, getPriceFormat, getPriceStep, priceToPips } from './pip';

describe('getPriceStep / getPriceFormat', () => {
  it.each([
    ['EUR_USD', 5, 0.00001],
    ['USD_JPY', 3, 0.001],
    ['XAU_USD', 3, 0.001],
  ])('%s: precision %i, minMove %d', (pair, precision, step) => {
    expect(getPriceStep(pair)).toBe(step);
    expect(getPriceFormat(pair)).toEqual({ type: 'price', precision, minMove: step });
  });
});

describe('getPipSize', () => {
  it.each([
    ['EUR_USD', 0.0001],
    ['GBP_CHF', 0.0001],
    ['USD_JPY', 0.01],
    ['GBP_JPY', 0.01],
    ['XAU_USD', 0.01],
  ])('%s -> %d', (pair, expected) => {
    expect(getPipSize(pair)).toBe(expected);
  });

  it('accepts the slash format used by the DB and REST APIs', () => {
    expect(getPipSize('USD/JPY')).toBe(0.01);
    expect(getPipSize('EUR/USD')).toBe(0.0001);
  });
});

describe('priceToPips', () => {
  it('uses 0.0001 pips for non-JPY pairs', () => {
    expect(priceToPips(0.00015, 'EUR_USD')).toBeCloseTo(1.5);
  });

  it('uses 0.01 pips for JPY-quoted pairs', () => {
    expect(priceToPips(0.015, 'USD_JPY')).toBeCloseTo(1.5);
  });

  it('uses 0.01 pips for gold', () => {
    expect(priceToPips(0.35, 'XAU_USD')).toBeCloseTo(35);
  });
});

describe('getPriceDecimals', () => {
  it('shows one digit past the pip', () => {
    expect(getPriceDecimals('EUR_USD')).toBe(5);
    expect(getPriceDecimals('USD_JPY')).toBe(3);
    expect(getPriceDecimals('XAU_USD')).toBe(3);
  });
});
