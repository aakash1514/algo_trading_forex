'use client';

import { useAppSelector } from '../../store';
import type { ReplaySocket } from '../../hooks/useReplaySocket';
import { PAIR_DISPLAY } from '../../lib/constants';
import { formatReplayTime } from '../../lib/replay';
import { EndSession } from './EndSession';
import { ReplayChart } from './ReplayChart';
import { ReplayControls } from './ReplayControls';

// The replay itself: a REPLAY badge and the replay clock next to the chart, so it can
// never be taken for live prices; the playback controls and their status line below.
export function ReplayScreen({ socket }: { socket: ReplaySocket }) {
  const session = useAppSelector((s) => s.replay.session);
  const account = useAppSelector((s) => s.replay.account);
  if (!session || !account) return null;

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
        <span className="text-[11px] text-terminal-muted">Historical Dukascopy data · bid candles</span>
        <div className="ml-auto">
          <EndSession openPositions={account.openPositions} pendingOrders={account.pendingOrders} />
        </div>
      </div>
      <ReplayControls socket={socket} />
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 border-r border-terminal-border">
          <ReplayChart />
        </div>
      </div>
    </div>
  );
}
