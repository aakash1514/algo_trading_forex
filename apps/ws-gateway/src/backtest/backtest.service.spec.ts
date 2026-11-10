import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { BacktestRunEntity } from '@forexedge/database';
import { BacktestService } from './backtest.service';
import type { BacktestResultStore } from './result-store';

const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const runOfA = { id: 'run-1', userId: USER_A, status: 'COMPLETED', minioObjectKey: 'backtests/run-1.json' } as BacktestRunEntity;

// The repo behaves like Postgres: the row is returned only when every
// where-condition matches, so an owner-scoped query hides A's run from B.
function makeService() {
  const repo = {
    findOne: jest.fn(async ({ where }: { where: Partial<BacktestRunEntity> }) =>
      where.id === runOfA.id && where.userId === runOfA.userId ? runOfA : null),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
  };
  const queue = { getJob: jest.fn(), add: jest.fn() };
  const results = { read: jest.fn().mockResolvedValue(Buffer.from('{"trades":[]}')) };
  const service = new BacktestService(repo as unknown as Repository<BacktestRunEntity>, queue as unknown as Queue,
    {} as DataSource, results as unknown as BacktestResultStore);
  return { service, repo, queue, results };
}

describe('BacktestService cross-user access', () => {
  it('owner can read their run', async () => {
    const { service } = makeService();
    await expect(service.findOne('run-1', USER_A)).resolves.toBe(runOfA);
  });

  it("user B gets 404 (not 403) on user A's run", async () => {
    const { service, repo } = makeService();
    await expect(service.findOne('run-1', USER_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'run-1', userId: USER_B } });
  });

  it('the owner gets the stored results.json; user B gets 404 and the store is never read', async () => {
    const { service, results } = makeService();
    await expect(service.getResults('run-1', USER_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(results.read).not.toHaveBeenCalled();
    await expect(service.getResults('run-1', USER_A)).resolves.toEqual(Buffer.from('{"trades":[]}'));
    expect(results.read).toHaveBeenCalledWith('backtests/run-1.json');
  });

  it("user B gets 404 on user A's results", async () => {
    const { service } = makeService();
    await expect(service.getResults('run-1', USER_B)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("user B gets 404 cancelling user A's run, and nothing is changed", async () => {
    const { service, repo, queue } = makeService();
    await expect(service.cancel('run-1', USER_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lists only the requesting user\'s runs', async () => {
    const { service, repo } = makeService();
    await service.list(USER_B);
    expect(repo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER_B } }));
  });

  it.each(['findOne', 'getResults', 'cancel'] as const)('%s with a missing user id fails closed (401)', async (method) => {
    const { service, repo } = makeService();
    await expect(service[method]('run-1', undefined as unknown as string)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('list with a missing user id fails closed instead of listing everyone', async () => {
    const { service, repo } = makeService();
    await expect(service.list(undefined as unknown as string)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.find).not.toHaveBeenCalled();
  });
});

describe('BacktestService submit: historical coverage', () => {
  const coverage = { pair: 'EUR/USD', price_decimals: 5, first_time: '2010-01-01T00:00:00Z', last_time: '2022-12-30T21:59:00Z' };
  function submitService(rows: unknown[]) {
    const repo = { create: jest.fn((x) => ({ id: 'run-9', ...x })), save: jest.fn() };
    const queue = { add: jest.fn() };
    const query = jest.fn().mockResolvedValue(rows);
    const service = new BacktestService(repo as unknown as Repository<BacktestRunEntity>, queue as unknown as Queue,
      { query } as unknown as DataSource, {} as BacktestResultStore);
    return { service, queue, query };
  }
  const dto = (over: Record<string, unknown> = {}) => ({
    instrument: 'EUR_USD', timeframe: '1h', fromDate: '2022-01-01', toDate: '2022-12-30', strategyName: 'ma_crossover', ...over,
  });

  it('queues a run inside the covered range, checking coverage for the DB pair', async () => {
    const { service, queue, query } = submitService([coverage]);
    await expect(service.submit(USER_A, dto())).resolves.toEqual({ runId: 'run-9' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM historical_coverage WHERE pair = $1'), ['EUR/USD']);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('rejects a range outside the history with the covered range in the message', async () => {
    const { service, queue } = submitService([coverage]);
    await expect(service.submit(USER_A, dto({ fromDate: '2026-06-01', toDate: '2026-06-12' })))
      .rejects.toThrow('2010-01-01T00:00:00.000Z to 2022-12-30T21:59:00.000Z');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects a pair without history', async () => {
    const { service } = submitService([]);
    await expect(service.submit(USER_A, dto({ instrument: 'EUR_GBP' }))).rejects.toThrow('No historical data for EUR/GBP');
  });

  it('stores the From and To days and queues the days as entered (To inclusive)', async () => {
    const { service, queue } = submitService([coverage]);
    const repo = (service as unknown as { repo: { create: jest.Mock } }).repo;
    await service.submit(USER_A, dto());
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      fromDate: new Date('2022-01-01T00:00:00Z'), toDate: new Date('2022-12-30T00:00:00Z'),
    }));
    expect(queue.add).toHaveBeenCalledWith('run-backtest',
      expect.objectContaining({ fromDate: '2022-01-01', toDate: '2022-12-30' }), { jobId: 'run-9' });
  });

  it('stores the default capital and size, and passes them to the job', async () => {
    const { service, queue } = submitService([coverage]);
    const repo = (service as unknown as { repo: { create: jest.Mock } }).repo;
    await service.submit(USER_A, dto());
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ initialCapital: '10000.00', lots: '0.10' }));
    expect(queue.add).toHaveBeenCalledWith('run-backtest',
      expect.objectContaining({ initialCapital: 10_000, lots: 0.1, parameters: { lots: 0.1 } }), { jobId: 'run-9' });
  });

  it('stores the requested capital and size', async () => {
    const { service, queue } = submitService([coverage]);
    const repo = (service as unknown as { repo: { create: jest.Mock } }).repo;
    await service.submit(USER_A, dto({ initialCapital: 25_000.5, lots: 1.25, parameters: { fastPeriod: 10, slowPeriod: 30 } }));
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ initialCapital: '25000.50', lots: '1.25' }));
    expect(queue.add).toHaveBeenCalledWith('run-backtest', expect.objectContaining({
      initialCapital: 25_000.5, lots: 1.25, parameters: { fastPeriod: 10, slowPeriod: 30, lots: 1.25 },
    }), { jobId: 'run-9' });
  });

  it('accepts From == To (one whole day)', async () => {
    const { service, queue } = submitService([coverage]);
    await expect(service.submit(USER_A, dto({ fromDate: '2022-12-30', toDate: '2022-12-30' }))).resolves.toEqual({ runId: 'run-9' });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('rejects From after To', async () => {
    const { service, queue } = submitService([coverage]);
    await expect(service.submit(USER_A, dto({ fromDate: '2022-12-30', toDate: '2022-12-29' })))
      .rejects.toThrow('fromDate 2022-12-30 is after toDate 2022-12-29');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('caps a 1m run at 366 days, both ends counted', async () => {
    const { service, queue } = submitService([coverage]);
    await expect(service.submit(USER_A, dto({ timeframe: '1m', fromDate: '2020-01-01', toDate: '2020-12-31' })))
      .resolves.toEqual({ runId: 'run-9' }); // 366 days (leap year)
    await expect(service.submit(USER_A, dto({ timeframe: '1m', fromDate: '2020-01-01', toDate: '2021-01-01' })))
      .rejects.toThrow('at most 366 days'); // 367 days
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
