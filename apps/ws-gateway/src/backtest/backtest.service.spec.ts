import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { BacktestRunEntity } from '@forexedge/database';
import { BacktestService } from './backtest.service';

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
  const service = new BacktestService(repo as unknown as Repository<BacktestRunEntity>, queue as unknown as Queue);
  return { service, repo, queue };
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

  it("user B gets 404 on user A's results URL", async () => {
    const { service } = makeService();
    await expect(service.getResultsUrl('run-1', USER_B)).rejects.toBeInstanceOf(NotFoundException);
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

  it.each(['findOne', 'getResultsUrl', 'cancel'] as const)('%s with a missing user id fails closed (401)', async (method) => {
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
