'use client';

import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '../../store';
import { useAppSelector } from '../../store';
import { useClosePositionMutation } from '../../store/api/order.api';
import { removePosition } from '../../store/slices/positions.slice';
import { useAppDispatch } from '../../store';
import { PAIR_DISPLAY } from '../../lib/constants';
import { cn } from '../../lib/cn';


export function PositionsTable() {
  const dispatch = useAppDispatch();
  const selectPositions = createSelector(
  (s: RootState) => s.positions.items,
  (items) => Object.values(items)
);
const positions = useAppSelector(selectPositions);
  const [closePosition, { isLoading }] = useClosePositionMutation();

  async function handleClose(positionId: string) {
    try {
      await closePosition(positionId).unwrap();
      dispatch(removePosition(positionId));
    } catch {
      // silently fail — position will refresh on next poll
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-terminal-border bg-terminal-surface shrink-0">
        <div className="px-4 py-2 text-[10px] font-medium text-accent-blue border-b-2 border-accent-blue uppercase tracking-wider">
          Positions ({positions.length})
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {positions.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[12px] text-terminal-muted">No open positions</p>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-terminal-border">
                {['Pair', 'Side', 'Lots', 'Open price', 'Current', 'Pips', 'P&L', 'Margin', ''].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] text-terminal-muted uppercase tracking-wider font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => (
                <tr key={pos.id} className="border-b border-terminal-border/50 hover:bg-terminal-elevated/50 transition-colors">
                  <td className="px-3 py-2 font-medium text-[#e2e4e9]">
                    {PAIR_DISPLAY[pos.instrument] ?? pos.instrument}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn(
                      'text-[10px] font-medium px-1.5 py-0.5 rounded',
                      pos.direction === 'BUY'
                        ? 'bg-accent-green/10 text-accent-green'
                        : 'bg-accent-red/10 text-accent-red'
                    )}>
                      {pos.direction}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-[#e2e4e9]">{pos.lots.toFixed(2)}</td>
                  <td className="px-3 py-2 tabular-nums text-terminal-muted">{pos.openPrice.toFixed(5)}</td>
                  <td className="px-3 py-2 tabular-nums text-[#e2e4e9]">{pos.currentPrice.toFixed(5)}</td>
                  <td className={cn('px-3 py-2 tabular-nums font-medium',
                    pos.pipPnl >= 0 ? 'text-accent-green' : 'text-accent-red'
                  )}>
                    {pos.pipPnl >= 0 ? '+' : ''}{pos.pipPnl.toFixed(1)}
                  </td>
                  <td className={cn('px-3 py-2 tabular-nums font-medium',
                    pos.unrealizedPnl >= 0 ? 'text-accent-green' : 'text-accent-red'
                  )}>
                    {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-terminal-muted">
                    ${pos.marginUsed.toFixed(2)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => handleClose(pos.id)}
                      disabled={isLoading}
                      className="text-[10px] text-terminal-muted hover:text-accent-red bg-terminal-elevated border border-terminal-border rounded px-2 py-0.5 transition-colors disabled:opacity-50"
                    >
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}