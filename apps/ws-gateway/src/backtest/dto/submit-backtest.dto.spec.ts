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

  it.each([
    [{ lots: 0.005 }, 'lots must not be less than 0.01'],
    [{ lots: 0.015 }, 'lots must be a number conforming to the specified constraints'],
    [{ lots: 101 }, 'lots must not be greater than 100'],
    [{ initialCapital: 99.99 }, 'initialCapital must not be less than 100'],
    [{ initialCapital: 10_000_000.01 }, 'initialCapital must not be greater than 10000000'],
    [{ initialCapital: '10000' }, 'initialCapital must be a number conforming to the specified constraints'],
  ])('rejects %p', async (over, message) => {
    expect(await errors(body(over))).toContain(message);
  });

  it('accepts capital and lots at their limits', async () => {
    expect(await errors(body({ lots: 0.01, initialCapital: 100 }))).toEqual([]);
    expect(await errors(body({ lots: 100, initialCapital: 10_000_000 }))).toEqual([]);
  });
});
