import { calendarCurrencies } from './replay-calendar';

describe('calendar currencies of a pair', () => {
  it.each([
    ['EUR/USD', ['EUR', 'USD']],
    ['GBP/USD', ['GBP', 'USD']],
    ['USD/JPY', ['USD', 'JPY']],
    ['XAU/USD', ['USD']],
  ])('%s -> %j', (pair, currencies) => {
    expect(calendarCurrencies(pair)).toEqual(currencies);
  });
});
