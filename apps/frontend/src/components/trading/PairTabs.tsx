'use client';

import { useAppDispatch, useAppSelector } from '../../store';
import { setActivePair } from '../../store/slices/market.slice';
import { MAJOR_PAIRS, PAIR_DISPLAY } from '../../lib/constants';
import { cn } from '../../lib/cn';


export function PairTabs() {
  const dispatch = useAppDispatch();
  const activePair = useAppSelector((s) => s.market.activePair);
  const prices = useAppSelector((s) => s.market.prices);

  return (
    <div className="flex items-stretch border-b border-terminal-border bg-terminal-surface shrink-0 overflow-x-auto">
      {MAJOR_PAIRS.map((pair) => {
        const price = prices[pair];
        const isActive = pair === activePair;

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
              <span className="tabular-nums text-[#e2e4e9]">
                {price.bid.toFixed(pair.includes('JPY') ? 3 : 5)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}