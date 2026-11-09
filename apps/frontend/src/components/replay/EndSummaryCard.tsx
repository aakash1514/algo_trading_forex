'use client';

import { cn } from '../../lib/cn';
import { formatUsd, RECENT_CLOSED_CAP, type EndSummary } from '../../lib/replay';

// What the ended session came to; "New replay" goes back to the start form
export function EndSummaryCard({ summary, onDone }: { summary: EndSummary; onDone: () => void }) {
  const negative = summary.netPnl.startsWith('-');
  return (
    <div data-testid="replay-summary" className="bg-terminal-surface border border-terminal-border rounded-lg p-4 space-y-3 max-w-md">
      <h2 className="text-[13px] font-medium text-[#e2e4e9]">Replay ended</h2>
      <dl className="space-y-1.5 text-[12px]">
        <div className="flex justify-between">
          <dt className="text-terminal-muted">Balance</dt>
          <dd data-testid="replay-summary-balance" className="tabular-nums text-[#e2e4e9]">
            {formatUsd(summary.startingBalance)} → {formatUsd(summary.finalBalance)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-terminal-muted">Net P&amp;L</dt>
          <dd data-testid="replay-summary-pnl"
            className={cn('tabular-nums font-medium', negative ? 'text-accent-red' : 'text-accent-green')}>
            {formatUsd(summary.netPnl, true)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-terminal-muted">Trades</dt>
          <dd data-testid="replay-summary-trades" className="tabular-nums text-[#e2e4e9]">
            {summary.trades}{summary.tradesCapped ? '+' : ''}
          </dd>
        </div>
      </dl>
      {summary.tradesCapped && (
        <p className="text-[11px] text-terminal-muted">
          The page only had your last {RECENT_CLOSED_CAP} closed trades, so there may have been more.
        </p>
      )}
      <button type="button" onClick={onDone} className="px-4 py-1.5 rounded bg-accent-blue text-white text-[12px] font-medium">
        New replay
      </button>
    </div>
  );
}
