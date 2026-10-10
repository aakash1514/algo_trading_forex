import { ArgumentMetadata, NotFoundException, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CandleQueryDto } from './dto/candle-query.dto';
import { MarketDataService } from './market-data.service';

// Same options as main.ts
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta: ArgumentMetadata = { type: 'query', metatype: CandleQueryDto };

describe('candle query source', () => {
  it('defaults to live', async () => {
    expect(await pipe.transform({}, meta)).toMatchObject({ source: 'live', limit: 500 });
  });

  it.each(['live', 'historical'])('accepts source=%s', async (source) => {
    expect(await pipe.transform({ source }, meta)).toMatchObject({ source });
  });

  it('rejects any other source', async () => {
    await expect(pipe.transform({ source: 'mixed' }, meta)).rejects.toThrow();
  });
});

describe('MarketDataService historical candles', () => {
  // Real EUR/USD M1 bar 2022-01-03 00:00 UTC (fixture EURUSD-2022-01-03.csv), in points at 5 dp
  const bar = {
    bucket: '2022-01-03T00:00:00.000Z', bid_open: 113726, bid_high: 113731, bid_low: 113726, bid_close: 113730,
    ask_open: 113732, ask_high: 113736, ask_low: 113732, ask_close: 113735, minutes: 1,
  };
  const coverage = { pair: 'EUR/USD', price_decimals: 5, first_time: '2010-01-01T00:00:00Z', last_time: '2022-12-30T21:59:00Z' };

  function service(coverageRows: unknown[], barRows: unknown[] = [bar]) {
    const query = jest.fn(async (sql: string) => (sql.includes('historical_coverage') ? coverageRows : barRows));
    return { svc: new MarketDataService({ query } as unknown as DataSource, {} as never), query };
  }

  it('reads the M1 table for the pair in DB format, scoped by window, latest first, and converts to mid', async () => {
    const { svc, query } = service([coverage]);
    const rows = await svc.getCandles('EUR_USD', '1m',
      { source: 'historical', from: '2022-01-03T00:00:00Z', to: '2022-01-03T23:59:00Z', limit: 2 });

    expect(query.mock.calls[0]).toEqual([expect.stringContaining('FROM historical_coverage WHERE pair = $1'), ['EUR/USD']]);
    const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain('FROM historical_candles\n');
    expect(sql).toContain('WHERE pair = $1 AND time >= $2 AND time <= $3');
    expect(sql).toContain('ORDER BY time DESC LIMIT $4');
    expect(params).toEqual(['EUR/USD', new Date('2022-01-03T00:00:00Z'), new Date('2022-01-03T23:59:00Z'), 2]);
    expect(rows).toEqual([{
      bucket: new Date('2022-01-03T00:00:00Z'), instrument: 'EUR_USD', pair: 'EUR/USD',
      open: 1.13729, high: 1.137335, low: 1.13729, close: 1.137325, minutes: 1, spread: 0.5,
    }]);
  });

  it('reads the aggregate for coarser timeframes', async () => {
    const { svc, query } = service([coverage]);
    await svc.getCandles('EUR_USD', '4h', { source: 'historical' });
    expect(query.mock.calls[1][0]).toContain('FROM historical_candles_4h');
    expect(query.mock.calls[1][0]).toContain('ORDER BY bucket DESC LIMIT $2');
  });

  it('404s a pair with no historical data', async () => {
    const { svc } = service([]);
    await expect(svc.getCandles('EUR_GBP', '1h', { source: 'historical' })).rejects.toThrow(NotFoundException);
  });

  it('422s a window outside the covered range, naming the range', async () => {
    const { svc } = service([coverage]);
    const call = svc.getCandles('EUR_USD', '1h', { source: 'historical', from: '2024-01-01T00:00:00Z' });
    await expect(call).rejects.toThrow(UnprocessableEntityException);
    await expect(call).rejects.toThrow('2010-01-01T00:00:00.000Z to 2022-12-30T21:59:00.000Z');
  });

  it('never reads historical tables for the live source', async () => {
    const { svc, query } = service([coverage], []);
    await svc.getCandles('EUR_USD', '1h', { source: 'live' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FROM candles_1h');
  });
});
