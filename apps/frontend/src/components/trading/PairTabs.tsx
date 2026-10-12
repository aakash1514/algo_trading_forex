'use client';

import { useAppDispatch, useAppSelector } from '../../store';
import { setActivePair } from '../../store/slices/market.slice';
import { MAJOR_PAIRS, PAIR_DISPLAY } from '../../lib/constants';
import { getPriceDecimals } from '../../lib/pip';
import { cn } from '../../lib/cn';
import { priceState } from '../../lib/feed';
import { useNow } from '../../hooks/useNow';


export function PairTabs() {
  const dispatch = useAppDispatch();
  const activePair = useAppSelector((s) => s.market.activePair);
  const prices = useAppSelector((s) => s.market.prices);
  const now = useNow();

  return (
    <div className="flex items-stretch border-b border-terminal-border bg-terminal-surface shrink-0 overflow-x-auto">
      {MAJOR_PAIRS.map((pair) => {
        const price = prices[pair];
        const isActive = pair === activePair;
        const stale = priceState(price, now) === 'stale';

        return (
          <button
            key={pair}
            onClick={() => dispatch(setActivePair(pair))}
            className={cn(
              'flex items-center gap-2 px-4 h-10 border-r border-terminal-border text-[11px] shrink-0 transition-colors',
              isActive
                ? 'bg-terminal-bg border-b-2 border-b-accent-blue text-[#e2e4e9]'
                : 'text-terminal-muted hover:text-[#e2e4e9] hover:bg-terminal-elevated'
            )}
          >
            <span className="font-medium">{PAIR_DISPLAY[pair]}</span>
            {price && (
              <span className={cn('tabular-nums', stale ? 'text-terminal-muted' : 'text-[#e2e4e9]')}>
                {price.bid.toFixed(getPriceDecimals(pair))}
              </span>
            )}
            {price?.source === 'MOCK' && (
              <span
                data-testid={`simulated-${pair}`}
                title="Simulated prices: not market data"
                className="rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wider bg-yellow-400/15 text-yellow-300"
              >
                Simulated
              </span>
            )}
            {stale && (
              <span
                data-testid={`stale-${pair}`}
                title="No fresh price: orders are rejected"
                className="rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wider bg-accent-red/15 text-accent-red"
              >
                Stale
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}