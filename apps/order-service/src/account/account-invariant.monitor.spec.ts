import { Logger } from '@nestjs/common';
import { AccountInvariantMonitor } from './account-invariant.monitor';

describe('AccountInvariantMonitor', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks balance and margin against the positions and logs each drifted account', async () => {
    // node-pg returns NUMERIC as strings
    const dataSource = { query: jest.fn().mockResolvedValue([
      { user_id: 'user-1', balance: '9916.84', expected_balance: '9916.84', margin_used: '1008.48', expected_margin: '900.00' },
    ]) };
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monitor = new AccountInvariantMonitor(dataSource as any);

    const drifts = await monitor.check();

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(params).toEqual([10000, 0.01]);
    expect(sql).toContain('SUM(p.realized_pnl) FILTER (WHERE NOT p.is_open)');
    expect(sql).toContain('SUM(p.swap_accrued)');
    expect(sql).toContain('SUM(p.margin_used) FILTER (WHERE p.is_open)');
    expect(sql).not.toContain('unrealized'); // open P&L is derived, nothing to compare
    expect(drifts).toEqual([{ userId: 'user-1', balance: 9916.84, expectedBalance: 9916.84, marginUsed: 1008.48, expectedMargin: 900 }]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Account drift — user user-1'));
  });

  it('logs nothing when every account is consistent', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monitor = new AccountInvariantMonitor({ query: jest.fn().mockResolvedValue([]) } as any);
    await expect(monitor.check()).resolves.toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('runs once a minute', async () => {
    jest.useFakeTimers();
    const query = jest.fn().mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monitor = new AccountInvariantMonitor({ query } as any);
    monitor.onModuleInit();
    await jest.advanceTimersByTimeAsync(2 * AccountInvariantMonitor.INTERVAL_MS);
    monitor.onModuleDestroy();
    jest.useRealTimers();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
