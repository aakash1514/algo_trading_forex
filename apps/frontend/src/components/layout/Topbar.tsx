'use client';

import Link from 'next/link';
import { useAppSelector, useAppDispatch } from '../../store';
import { useGetCurrentSessionQuery } from '../../store/api/domain.api';
import { clearCredentials } from '../../store/slices/auth.slice';
import { useRouter } from 'next/navigation';
import { MAJOR_PAIRS, PAIR_DISPLAY } from '../../lib/constants';
import { cn } from '../../lib/cn';
import { getPriceDecimals } from '../../lib/pip';

export function Topbar() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const user = useAppSelector((s) => s.auth.user);
  const prices = useAppSelector((s) => s.market.prices);
  const { data: session } = useGetCurrentSessionQuery(undefined, {
    pollingInterval: 30_000,
  });

  function handleLogout() {
    dispatch(clearCredentials());
    router.replace('/login');
  }

  const displayPairs = MAJOR_PAIRS.slice(0, 6);

  return (
    <header className="h-11 bg-terminal-surface border-b border-terminal-border flex items-center px-4 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2 mr-6 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-accent-green shadow-[0_0_6px_#22c55e]" />
        <span className="text-[11px] font-medium tracking-[0.1em] uppercase text-[#e2e4e9]">
          ForexEdge
        </span>
      </div>

      {/* Nav links */}
      <div className="flex items-stretch mr-4 shrink-0 border-l border-terminal-border">
        {[
          { href: '/dashboard', label: 'Terminal' },
          { href: '/backtest', label: 'Backtest' },
          { href: '/calendar', label: 'Calendar' },
        ].map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center px-3 h-11 text-[11px] text-terminal-muted hover:text-[#e2e4e9] border-r border-terminal-border transition-colors"
          >
            {label}
          </Link>
        ))}
      </div>

      {/* Live price ticker strip */}
      <div className="flex items-stretch gap-0 flex-1 overflow-hidden">
        {displayPairs.map((pair) => {
          const price = prices[pair];
          return (
            <div
              key={pair}
              className="flex items-center gap-2 px-3 h-11 border-r border-terminal-border text-[11px] shrink-0"
            >
              <span className="text-terminal-muted">{PAIR_DISPLAY[pair]}</span>
              <span className="tabular-nums text-[#e2e4e9] font-medium">
                {price ? price.bid.toFixed(getPriceDecimals(pair)) : '—'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3 ml-4 shrink-0">
        {/* Session badges */}
        {session && (
          <div className={cn(
            'text-[10px] font-medium px-2 py-0.5 rounded',
            session.open
              ? 'bg-accent-green/10 text-accent-green border border-accent-green/20'
              : 'bg-terminal-elevated text-terminal-muted border border-terminal-border'
          )}>
            {session.session}
          </div>
        )}

        {/* Live indicator */}
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
          <span className="text-[10px] text-terminal-muted">Live</span>
        </div>

        {/* User + logout */}
        <div className="flex items-center gap-2 pl-3 border-l border-terminal-border">
          <div className="w-6 h-6 rounded-full bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center">
            <span className="text-[9px] font-medium text-accent-blue uppercase">
              {user?.username?.slice(0, 2) ?? 'AD'}
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="text-[10px] text-terminal-muted hover:text-[#e2e4e9] transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}