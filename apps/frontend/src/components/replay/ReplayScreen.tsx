'use client';

import { useCallback, useRef, useState } from 'react';
import { useAppSelector } from '../../store';
import type { ReplaySocket } from '../../hooks/useReplaySocket';
import { useReplayActions } from '../../hooks/useReplayActions';
import { useReplayShortcuts } from '../../hooks/useReplayShortcuts';
import { PAIR_DISPLAY } from '../../lib/constants';
import { formatReplayTime } from '../../lib/replay';
import { EndSession } from './EndSession';
import { ReplayChart } from './ReplayChart';
import { ReplayControls } from './ReplayControls';
import { ReplayAccountStrip } from './ReplayAccountStrip';
import { ReplayOrderPanel, type OrderPanelHandle } from './ReplayOrderPanel';
import { ReplayPositions } from './ReplayPositions';
import { ReplayShortcutsHelp } from './ReplayShortcutsHelp';

// The replay itself: a REPLAY badge and the replay clock next to the chart, so it can
// never be taken for live prices; the playback controls and their status line below.
// The keyboard shortcuts live as long as this screen (useReplayShortcuts).
export function ReplayScreen({ socket }: { socket: ReplaySocket }) {
  const session = useAppSelector((s) => s.replay.session);
  const account = useAppSelector((s) => s.replay.account);
  const actions = useReplayActions(socket);
  const orderPanel = useRef<OrderPanelHandle>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const toggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  useReplayShortcuts({ actions, orderPanel, helpOpen, toggleHelp, closeHelp });
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
          <EndSession sessionId={session.id} openPositions={account.openPositions} pendingOrders={account.pendingOrders} />
        </div>
      </div>
      <ReplayControls socket={socket} actions={actions} helpOpen={helpOpen} onToggleHelp={toggleHelp} />
      <div className="flex-1 flex overflow-hidden">
        <div className="relative flex-1 flex flex-col min-w-0 border-r border-terminal-border">
          <ReplayChart />
          {helpOpen && <ReplayShortcutsHelp onClose={closeHelp} />}
        </div>
        <div className="w-64 shrink-0 flex flex-col bg-terminal-surface overflow-y-auto">
          <ReplayOrderPanel ref={orderPanel} />
          <ReplayAccountStrip />
        </div>
      </div>
      <div className="h-48 shrink-0 border-t border-terminal-border overflow-hidden">
        <ReplayPositions />
      </div>
    </div>
  );
}
