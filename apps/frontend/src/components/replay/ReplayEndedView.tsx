'use client';

import { useAppSelector } from '../../store';
import { PAIR_DISPLAY } from '../../lib/constants';
import { formatReplayTime } from '../../lib/replay';
import { ReplayChart } from './ReplayChart';
import { ReplayPositions } from './ReplayPositions';

// An ENDED session from "My replays", read-only: the chart up to where it ended, its closed
// trades and statistics. No controls, order panel or keyboard shortcuts are mounted (the
// server refuses any command or order on an ENDED session anyway).
export function ReplayEndedView({ onBack }: { onBack: () => void }) {
  const session = useAppSelector((s) => s.replay.session);
  if (!session) return null;

  return (
    <div className="h-full flex flex-col" data-testid="replay-ended-view">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-terminal-border bg-terminal-surface shrink-0">
        <span data-testid="replay-badge"
          className="px-2.5 py-1 rounded bg-amber-400 text-[#1a1200] text-[13px] font-bold tracking-[0.2em]">
          REPLAY
        </span>
        <span data-testid="replay-title" className="text-[13px] font-medium text-[#e2e4e9] truncate max-w-[24rem]">{session.title}</span>
        <span className="text-[13px] text-terminal-muted">{PAIR_DISPLAY[session.instrument] ?? session.instrument} · {session.timeframe}</span>
        <span data-testid="replay-clock" className="text-[13px] tabular-nums text-amber-300">
          Ended at replay time {formatReplayTime(session.clockTime)}
        </span>
        <span data-testid="replay-read-only" className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-terminal-elevated text-terminal-muted">
          Read-only
        </span>
        <button type="button" onClick={onBack}
          className="ml-auto px-3 py-1.5 rounded border border-terminal-border text-[12px] text-terminal-muted hover:text-[#e2e4e9]">
          My replays
        </button>
      </div>
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ReplayChart />
      </div>
      <div className="h-56 shrink-0 border-t border-terminal-border overflow-hidden">
        <ReplayPositions readOnly />
      </div>
    </div>
  );
}
