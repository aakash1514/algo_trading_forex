'use client';

import { useAppSelector } from '../../store';
import { useGetReplayStatsQuery } from '../../store/api/replay.api';
import { selectClosedReplayPositions } from '../../store/slices/replay.slice';
import { formatUsd, replayErrorMessage } from '../../lib/replay';
import type { ReplayStats } from '../../types/replay.types';

const DASH = '—';
const usd = (v: string | null, signed = false) => (v === null ? DASH : formatUsd(v, signed));
const pct = (v: string | null) => (v === null ? DASH : `${v}%`);

// Every line of the panel: label, value as shown, and the test id
export function statsRows(s: ReplayStats): [string, string, string][] {
  return [
    ['Trades', String(s.trades), 'trades'],
    ['Wins / losses', `${s.wins} / ${s.losses}${s.breakeven ? ` (${s.breakeven} even)` : ''}`, 'wins-losses'],
    ['Win rate', pct(s.winRatePct), 'win-rate'],
    ['Net P&L', usd(s.netPnlUsd, true), 'net'],
    ['Gross profit', usd(s.grossProfitUsd), 'gross-profit'],
    ['Gross loss', usd(s.grossLossUsd), 'gross-loss'],
    ['Profit factor', s.profitFactor ?? DASH, 'profit-factor'],
    ['Average win', usd(s.averageWinUsd), 'average-win'],
    ['Average loss', usd(s.averageLossUsd), 'average-loss'],
    ['Largest win', usd(s.largestWinUsd), 'largest-win'],
    ['Largest loss', usd(s.largestLossUsd), 'largest-loss'],
    ['Max drawdown (closed-trade balance)', `${usd(s.maxDrawdownUsd)} (${pct(s.maxDrawdownPct)})`, 'drawdown'],
  ];
}

// The session's statistics, computed by replay-service from every closed trade (not only
// the ones loaded here). Asked again whenever a trade closes: the cache key includes the
// closed trades the store knows, so a new close is a new request.
export function ReplayStatsPanel({ sessionId }: { sessionId: string }) {
  const closed = useAppSelector(selectClosedReplayPositions);
  const closedKey = `${closed.length}:${closed[0]?.id ?? ''}`;
  const { data, error, isFetching } = useGetReplayStatsQuery({ sessionId, closedKey });

  if (error) return <p role="alert" className="p-4 text-accent-red">{replayErrorMessage(error)}</p>;
  if (!data) return <p className="p-4 text-terminal-muted">Loading…</p>;
  return (
    <div className="p-3" data-testid="replay-stats" aria-busy={isFetching}>
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1.5">
        {statsRows(data).map(([label, value, id]) => (
          <div key={id} className="flex justify-between gap-3 border-b border-terminal-border/40 py-1">
            <dt className="text-terminal-muted">{label}</dt>
            <dd data-testid={`replay-stat-${id}`} className="tabular-nums text-[#e2e4e9]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] text-terminal-muted">
        From every closed trade of this session, as replay-service computes them. The drawdown is measured on the
        balance after each close (open positions are not counted).
      </p>
    </div>
  );
}
