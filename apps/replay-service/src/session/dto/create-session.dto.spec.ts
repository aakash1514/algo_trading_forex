import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateSessionDto } from './create-session.dto';

// The same pipe options as replay-service main.ts
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta: ArgumentMetadata = { type: 'body', metatype: CreateSessionDto };

const body = (over: Record<string, unknown> = {}) =>
  ({ instrument: 'EUR_USD', startTime: '2022-03-01T09:30Z', startingBalance: 10000, timeframe: '1h', ...over });

const errors = async (value: unknown) => {
  try {
    await pipe.transform(value, meta);
    return [];
  } catch (err) {
    if (!(err instanceof BadRequestException)) throw err;
    return (err.getResponse() as { message: string[] }).message;
  }
};

describe('CreateSessionDto through the ValidationPipe', () => {
  it('accepts a session body, with or without the starting balance', async () => {
    expect(await errors(body())).toEqual([]);
    const withoutBalance: Record<string, unknown> = body();
    delete withoutBalance['startingBalance'];
    expect(await errors(withoutBalance)).toEqual([]);
  });

  it.each(['EUR_USD', 'GBP_USD', 'USD_JPY', 'XAU_USD'])('accepts %s', async (instrument) => {
    expect(await errors(body({ instrument }))).toEqual([]);
  });

  it.each(['EUR/USD', 'EURUSD', 'EUR_GBP', 'USD_CHF', ''])('rejects instrument %p', async (instrument) => {
    expect((await errors(body({ instrument }))).join()).toContain('instrument must be one of');
  });

  it.each([
    '2010-01-01T00:00Z', '2010-01-01T00:00:00Z', '2010-01-01T00:00:00.000Z', '2022-12-30T23:59Z', '2016-02-29T12:00Z',
  ])('accepts start %p', async (startTime) => {
    expect(await errors(body({ startTime }))).toEqual([]);
  });

  it.each([
    ['before the history', '2009-12-31T23:59Z'],
    ['after the last day', '2022-12-31T00:00Z'],
    ['an impossible date', '2022-02-30T10:00Z'],
    ['an impossible time', '2022-03-01T24:00Z'],
    ['seconds', '2022-03-01T09:30:30Z'],
    ['no zone', '2022-03-01T09:30'],
    ['another zone', '2022-03-01T09:30+01:00'],
    ['a date only', '2022-03-01'],
    ['a number', 1646127000000],
  ])('rejects start time: %s', async (_case, startTime) => {
    expect((await errors(body({ startTime })))).toEqual(
      ['startTime must be a whole UTC minute between 2010-01-01T00:00Z and 2022-12-30T23:59Z']);
  });

  it.each([99.99, 10_000_000.01, 1000.123, -5, '10000'])('rejects starting balance %p', async (startingBalance) => {
    expect((await errors(body({ startingBalance }))).join()).toContain('startingBalance');
  });

  it.each(['2h', '1w', '1H', ''])('rejects timeframe %p', async (timeframe) => {
    expect((await errors(body({ timeframe }))).join()).toContain('timeframe must be one of');
  });

  it('rejects fields the API does not take', async () => {
    expect((await errors(body({ balance: 1e6 })))).toEqual(['property balance should not exist']);
  });
});
