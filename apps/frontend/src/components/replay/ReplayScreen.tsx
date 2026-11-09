'use client';

import { useAppSelector } from '../../store';
import type { ReplaySocket } from '../../hooks/useReplaySocket';
import { PAIR_DISPLAY } from '../../lib/constants';
import { formatReplayTime } from '../../lib/replay';
import { EndSession } from './EndSession';

// The replay itself: a REPLAY badge and the replay clock, so it can never be taken
// for live prices.
export function ReplayScreen({ socket }: { socket: ReplaySocket }) {
  const session = useAppSelector((s) => s.replay.session);
  const account = useAppSelector((s) => s.replay.account);
  if (!session || !account) return null;
  void socket;

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-terminal-border bg-terminal-surface shrink-0">
        <span data-testid="replay-badge"
          className="px-2.5 py-1 rounded bg-amber-400 text-[#1a1200] text-[13px] font-bold tracking-[0.2em]">
          REPLAY
        </span>
        <span className="text-[13px] font-medium text-[#e2e4e9]">{PAIR_DISPLAY[session.instrument] ?? session.instrument}</span>
        <span data-testid="replay-clock" className="text-[13px] tabular-nums text-amber-300">
          Replay time: {formatReplayTime(session.clockTime)}
        </span>
        <div className="ml-auto">
          <EndSession openPositions={account.openPositions} pendingOrders={account.pendingOrders} />
        </div>
      </div>
    </div>
  );
}
