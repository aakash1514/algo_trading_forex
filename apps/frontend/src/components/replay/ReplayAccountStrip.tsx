'use client';

import { useAppSelector } from '../../store';
import { cn } from '../../lib/cn';
import { formatUsd } from '../../lib/replay';

// The replay account at the clock, in USD, exactly as the server computed it
export function ReplayAccountStrip() {
  const account = useAppSelector((s) => s.replay.account);
  if (!account) return null;
  const pnlNegative = account.unrealizedPnlUsd.startsWith('-');
  const items = [
    { label: 'Balance', value: formatUsd(account.balance), tone: '' },
    { label: 'Equity', value: formatUsd(account.equity), tone: '' },
    { label: 'Unrealised P&L', value: formatUsd(account.unrealizedPnlUsd, true),
      tone: pnlNegative ? 'text-accent-red' : 'text-accent-green' },
    { label: 'Margin used', value: formatUsd(account.marginUsed), tone: '' },
    { label: 'Free margin', value: formatUsd(account.freeMargin), tone: '' },
  ];
  return (
    <div data-testid="replay-account" className="p-3">
      <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-2">Replay account</p>
      <dl className="grid grid-cols-2 gap-1.5">
        {items.map((m) => (
          <div key={m.label} className="bg-terminal-elevated rounded p-2">
            <dt className="text-[9px] text-terminal-muted uppercase tracking-wide mb-0.5">{m.label}</dt>
            <dd className={cn('text-[12px] font-medium tabular-nums', m.tone || 'text-[#e2e4e9]')}>{m.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
