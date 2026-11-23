import { compareStats, STATS_FIELDS, statsFromRow } from './stats-sql';

// The comparison itself: it must not pass on a missing field or on any difference
describe('compareStats', () => {
  const row = { trades: 2, wins: 1, losses: 1, breakeven: 0, win_rate_pct: '50.00', net_pnl_usd: '-0.10',
    gross_profit_usd: '1.00', gross_loss_usd: '-1.10', profit_factor: '0.91', average_win_usd: '1.00',
    average_loss_usd: '-1.10', largest_win_usd: '1.00', largest_loss_usd: '-1.10', max_drawdown_usd: '1.10',
    max_drawdown_pct: '0.01' };
  const sql = statsFromRow(row);
  const api = Object.fromEntries(STATS_FIELDS.map((f) => [f, sql[f]]));

  it('reads every field from its column', () => {
    expect(Object.values(sql).every((v) => v !== null)).toBe(true);
  });

  it('equal fields: no difference', () => {
    expect(compareStats(api, sql)).toEqual([]);
  });

  it('a cent off, a missing field and null against a value are all differences', () => {
    const changed: Record<string, unknown> = { ...api, averageWinUsd: '1.01', profitFactor: null };
    delete changed['netPnlUsd'];
    expect(compareStats(changed, sql).map((d) => d.field)).toEqual(['netPnlUsd', 'profitFactor', 'averageWinUsd']);
  });
});
