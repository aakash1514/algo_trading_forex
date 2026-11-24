'use client';

import { useAppSelector } from '../../store';
import { PAIR_DISPLAY } from '../../lib/constants';
import { formatReplayTime, formatUsd } from '../../lib/replay';
import { EndSession } from './EndSession';

// The user's active session, from the socket's state: resume it (it stays paused) or end it
export function ResumeCard({ onResume }: { onResume: () => void }) {
  const session = useAppSelector((s) => s.replay.session);
  const account = useAppSelector((s) => s.replay.account);
  if (!session || !account) return null;

  const rows = [
    ['Pair', PAIR_DISPLAY[session.instrument] ?? session.instrument],
    ['Replay time', formatReplayTime(session.clockTime)],
    ['Equity', formatUsd(account.equity)],
    ['Open positions', String(account.openPositions)],
  ];
  return (
    <div data-testid="replay-resume-card" className="bg-terminal-surface border border-terminal-border rounded-lg p-4 space-y-3 max-w-md">
      <h2 className="text-[13px] font-medium text-[#e2e4e9]">You have a replay in progress</h2>
      <dl className="grid grid-cols-2 gap-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="bg-terminal-elevated rounded p-2">
            <dt className="text-[9px] text-terminal-muted uppercase tracking-wide">{label}</dt>
            <dd className="text-[12px] font-medium tabular-nums text-[#e2e4e9]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-start gap-2">
        <button type="button" onClick={onResume}
          className="px-4 py-1.5 rounded bg-accent-blue text-white text-[12px] font-medium">
          Resume
        </button>
        <EndSession sessionId={session.id} openPositions={account.openPositions} pendingOrders={account.pendingOrders} />
      </div>
    </div>
  );
}
