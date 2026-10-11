'use client';

import { useAppSelector } from '../../store';
import { cn } from '../../lib/cn';
import { formatSignedUsd } from '../../lib/format';

export function AccountPanel() {
  const summary = useAppSelector((s) => s.account.summary);

  if (!summary) {
    return (
      <div className="p-4 border-t border-terminal-border">
        <p className="text-[11px] text-terminal-muted">Loading account...</p>
      </div>
    );
  }

    const marginPct = (summary.marginLevel ?? 0) > 1000
    ? 100
    : ((summary.marginLevel ?? 0) / 1000) * 100;

    const marginColor =
    (summary.marginLevel ?? 0) > 500 ? 'bg-accent-green' :
    (summary.marginLevel ?? 0) > 200 ? 'bg-yellow-500' :
    'bg-accent-red';

const metrics = [
  {
    label: 'Balance',
    value: `$${(summary.balance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    color: '',
  },
  {
    label: 'Equity',
    value: `$${(summary.equity ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    color: (summary.equity ?? 0) >= (summary.balance ?? 0) ? 'text-accent-green' : 'text-accent-red',
  },
  {
    label: 'Free margin',
    value: `$${(summary.freeMargin ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    color: '',
  },
  {
    label: 'Open P&L',
    value: formatSignedUsd(summary.unrealizedPnl ?? 0),
    color: (summary.unrealizedPnl ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red',
  },
];

  return (
    <div className="border-t border-terminal-border p-3">
      <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-3">
        Account
      </p>

      <div className="grid grid-cols-2 gap-1.5 mb-3">
        {metrics.map((m) => (
          <div key={m.label} className="bg-terminal-elevated rounded p-2">
            <p className="text-[9px] text-terminal-muted uppercase tracking-wide mb-0.5">{m.label}</p>
            <p className={cn('text-[12px] font-medium tabular-nums', m.color || 'text-[#e2e4e9]')}>
              {m.value}
            </p>
          </div>
        ))}
      </div>

      {/* Margin level gauge */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-terminal-muted uppercase tracking-wide shrink-0">Margin</span>
        <div className="flex-1 h-1 bg-terminal-elevated rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-500', marginColor)}
            style={{ width: `${Math.min(marginPct, 100)}%` }}
          />
        </div>
        <span className={cn('text-[11px] font-medium tabular-nums shrink-0',
            (summary.marginLevel ?? 0) > 500 ? 'text-accent-green' :
            (summary.marginLevel ?? 0) > 200 ? 'text-yellow-500' : 'text-accent-red'
            )}>
            {(summary.marginLevel ?? 0).toFixed(0)}%
            </span>
      </div>
    </div>
  );
}