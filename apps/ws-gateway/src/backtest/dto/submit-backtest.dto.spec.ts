import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { SubmitBacktestDto } from './submit-backtest.dto';

// The same pipe options as ws-gateway main.ts
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta: ArgumentMetadata = { type: 'body', metatype: SubmitBacktestDto };

// The body the backtest form sends
const body = (over: Record<string, unknown> = {}) => ({
  strategyName: 'ma_crossover', instrument: 'EUR_USD', timeframe: '1h',
  fromDate: '2022-01-01', toDate: '2022-12-30', parameters: { fastPeriod: 10, slowPeriod: 30 }, lots: 0.1, ...over,
});

const errors = async (value: unknown) => {
  try {
    await pipe.transform(value, meta);
    return [];
  } catch (err) {
    if (!(err instanceof BadRequestException)) throw err;
    return (err.getResponse() as { message: string[] }).message;
  }
};

describe('SubmitBacktestDto through the ValidationPipe', () => {
  it('accepts the form body', async () => {
    expect(await errors(body())).toEqual([]);
  });

  it.each([
    ['a timestamp', '2022-12-30T00:00:00.000Z'],
    ['an impossible date', '2022-02-30'],
    ['a non-ISO date', '30/12/2022'],
  ])('rejects %s as toDate', async (_, toDate) => {
    expect(await errors(body({ toDate }))).toEqual(['toDate must be a calendar date (YYYY-MM-DD)']);
  });

  it('rejects a missing fromDate', async () => {
    const missing: Record<string, unknown> = body();
    delete missing['fromDate'];
    expect(await errors(missing)).toEqual(['fromDate must be a calendar date (YYYY-MM-DD)']);
  });
});
