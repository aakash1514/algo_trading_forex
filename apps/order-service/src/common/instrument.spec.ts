import { instrumentToPair, pairCurrencies } from './instrument';

describe('instrumentToPair', () => {
  it.each([
    ['EUR_USD', 'EUR/USD'],
    ['USD_JPY', 'USD/JPY'],
    ['XAU_USD', 'XAU/USD'],
  ])('%s -> %s', (instrument, pair) => {
    expect(instrumentToPair(instrument)).toBe(pair);
  });

  it.each(['EUR/USD', 'EURUSD', 'eur_usd', 'EUR_USDX', ''])('rejects %p', (instrument) => {
    expect(() => instrumentToPair(instrument)).toThrow(/Invalid instrument/);
  });
});

describe('pairCurrencies', () => {
  it('splits a slash-format pair into base and quote', () => {
    expect(pairCurrencies('GBP/JPY')).toEqual(['GBP', 'JPY']);
  });
});
