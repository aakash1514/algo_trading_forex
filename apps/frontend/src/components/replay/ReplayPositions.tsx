'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  useCancelReplayOrderMutation, useCloseReplayPositionMutation, useLazyGetReplayTradesQuery,
} from '../../store/api/replay.api';
import {
  accountReceived, positionsReceived, selectClosedReplayPositions, selectLiveReplayPositions,
} from '../../store/slices/replay.slice';
import { cn } from '../../lib/cn';
import { centsToDecimal, formatReplayTime, formatUsd, mergeClosedTrades, replayErrorMessage } from '../../lib/replay';
import { openPnlCents } from '../../lib/replay-money';
import type { OrderResult, ReplayPosition } from '../../types/replay.types';
import { ReplayStatsPanel } from './ReplayStatsPanel';

const TH = 'text-left px-3 py-2 text-[10px] text-terminal-muted uppercase tracking-wider font-medium whitespace-nowrap';
const TD = 'px-3 py-1.5 tabular-nums whitespace-nowrap';
const EXIT_REASONS: Record<string, string> = { SL: 'Stop loss', TP: 'Take profit', MANUAL: 'Manual', SESSION_END: 'Session end' };

function SideTag({ side }: { side: 'BUY' | 'SELL' }) {
  return (
    <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded',
      side === 'BUY' ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red')}>
      {side === 'BUY' ? 'LONG' : 'SHORT'}
    </span>
  );
}

function Money({ cents }: { cents: string | null }) {
  if (cents === null) return <span className="text-terminal-muted">—</span>;
  return <span className={cents.startsWith('-') ? 'text-accent-red' : 'text-accent-green'}>{formatUsd(cents, true)}</span>;
}

// The closed-trade history beyond what the socket's state carries (its last 50): pages of
// 20 from replay-service, newest first, loaded on opening the tab and by Load more. They
// stay in this component (only this tab uses them) and are merged by id with the
// store's closed trades, so a trade that closes by socket goes to the top and a trade
// both sources hold is listed once. A new session starts over.
function useClosedTradePages(sessionId: string | undefined, active: boolean) {
  const [pages, setPages] = useState<{ sessionId: string; trades: ReplayPosition[]; cursor: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchPage, { isFetching }] = useLazyGetReplayTradesQuery();

  const load = useCallback(async (cursor?: string) => {
    if (!sessionId) return;
    setError(null);
    const result = await fetchPage({ sessionId, cursor });
    if (!result.data) {
      setError(replayErrorMessage(result.error));
      return;
    }
    const page = result.data;
    setPages((prev) => ({
      sessionId,
      trades: cursor && prev?.sessionId === sessionId ? [...prev.trades, ...page.trades] : page.trades,
      cursor: page.nextCursor,
    }));
  }, [fetchPage, sessionId]);

  const current = pages?.sessionId === sessionId ? pages : null;
  // the first page, once per session, when the tab is opened
  useEffect(() => {
    if (active && sessionId && !current) void load();
  }, [active, sessionId, current, load]);

  return {
    trades: current?.trades ?? [],
    hasMore: current?.cursor != null,
    loadMore: () => { if (current?.cursor) void load(current.cursor); },
    loading: isFetching,
    error,
  };
}

// Pending orders and open positions (with live P&L at the clock), and the closed
// trades (the state's latest, then pages on demand). A Close is pending until the next minute.
export function ReplayPositions() {
  const dispatch = useAppDispatch();
  const session = useAppSelector((s) => s.replay.session);
  const bar = useAppSelector((s) => s.replay.currentBar);
  const decimals = useAppSelector((s) => s.replay.priceDecimals);
  const live = useAppSelector(selectLiveReplayPositions);
  const closed = useAppSelector(selectClosedReplayPositions);
  const [tab, setTab] = useState<'open' | 'closed' | 'stats'>('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOrder] = useCancelReplayOrderMutation();
  const [closePosition] = useCloseReplayPositionMutation();
  const pages = useClosedTradePages(session?.id, tab === 'closed');
  const allClosed = useMemo(() => mergeClosedTrades(closed, pages.trades), [closed, pages.trades]);
  if (!session || !bar) return null;

  async function act(id: string, run: (id: string) => Promise<{ data?: OrderResult; error?: unknown }>) {
    setBusyId(id);
    setError(null);
    const result = await run(id);
    if (result.data) {
      dispatch(positionsReceived([result.data.position]));
      dispatch(accountReceived(result.data.account));
    } else {
      setError(replayErrorMessage(result.error));
    }
    setBusyId(null);
  }

  const status = (p: ReplayPosition) => {
    if (p.status === 'PENDING') return <span className="text-amber-300">Pending · fills at the next minute&apos;s open</span>;
    if (p.exitRequestedAt) return <span className="text-amber-300">Closing at the next minute&apos;s open</span>;
    return <span className="text-[#e2e4e9]">Open</span>;
  };
  const pnl = (p: ReplayPosition) => {
    const cents = openPnlCents(p, bar, session.instrument, decimals);
    return cents === null ? null : centsToDecimal(cents);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex border-b border-terminal-border bg-terminal-surface shrink-0" role="tablist">
        {([['open', `Open & pending (${live.length})`], ['closed', `Closed trades (${allClosed.length}${pages.hasMore ? '+' : ''})`],
          ['stats', 'Statistics']] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={cn('px-4 py-2 text-[10px] font-medium uppercase tracking-wider border-b-2',
              tab === key ? 'text-accent-blue border-accent-blue' : 'text-terminal-muted border-transparent hover:text-[#e2e4e9]')}>
            {label}
          </button>
        ))}
        {error && <p role="alert" className="ml-auto self-center px-4 text-[11px] text-accent-red">{error}</p>}
      </div>
      <div className="flex-1 overflow-auto text-[11px]">
        {tab === 'closed' && pages.error && (
          <p role="alert" data-testid="replay-trades-error" className="px-3 pt-2 text-accent-red">{pages.error}</p>
        )}
        {tab === 'stats' ? <ReplayStatsPanel sessionId={session.id} /> : tab === 'open' ? (
          live.length === 0 ? <p className="p-4 text-terminal-muted">No open positions or pending orders</p> : (
            <table className="w-full" data-testid="replay-open-positions">
              <thead><tr className="border-b border-terminal-border">
                {['Status', 'Side', 'Lots', 'Entry', 'SL', 'TP', 'P&L', ''].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {live.map((p) => (
                  <tr key={p.id} data-testid="replay-position-row" className="border-b border-terminal-border/50">
                    <td className={TD}>{status(p)}</td>
                    <td className={TD}><SideTag side={p.side} /></td>
                    <td className={cn(TD, 'text-[#e2e4e9]')}>{p.lots}</td>
                    <td className={cn(TD, 'text-[#e2e4e9]')}>{p.entryPrice ?? '—'}</td>
                    <td className={cn(TD, 'text-terminal-muted')}>{p.stopLoss ?? '—'}</td>
                    <td className={cn(TD, 'text-terminal-muted')}>{p.takeProfit ?? '—'}</td>
                    <td className={cn(TD, 'font-medium')} data-testid="replay-position-pnl"><Money cents={pnl(p)} /></td>
                    <td className={TD}>
                      {p.status === 'PENDING' ? (
                        <button type="button" disabled={busyId === p.id} onClick={() => act(p.id, cancelOrder)}
                          className="text-[10px] px-2 py-1 rounded border border-terminal-border text-terminal-muted hover:text-[#e2e4e9] disabled:opacity-40">
                          Cancel
                        </button>
                      ) : (
                        <button type="button" disabled={busyId === p.id || p.exitRequestedAt !== null || session.endOfData}
                          onClick={() => act(p.id, closePosition)}
                          className="text-[10px] px-2 py-1 rounded border border-accent-red/30 text-accent-red hover:bg-accent-red/10 disabled:opacity-40">
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          allClosed.length === 0 ? <p className="p-4 text-terminal-muted">{pages.loading ? 'Loading…' : 'No closed trades yet'}</p> : (
            <>
            <table className="w-full" data-testid="replay-closed-trades">
              <thead><tr className="border-b border-terminal-border">
                {['Closed (UTC)', 'Side', 'Lots', 'Entry → exit', 'Reason', 'Net P&L'].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {allClosed.map((p) => (
                  <tr key={p.id} data-testid="replay-closed-row" data-id={p.id} className="border-b border-terminal-border/50">
                    <td className={cn(TD, 'text-terminal-muted')}>{p.exitTime ? formatReplayTime(p.exitTime) : '—'}</td>
                    <td className={TD}><SideTag side={p.side} /></td>
                    <td className={cn(TD, 'text-[#e2e4e9]')}>{p.lots}</td>
                    <td className={cn(TD, 'text-[#e2e4e9]')}>{p.entryPrice} → {p.exitPrice}</td>
                    <td className={cn(TD, 'text-terminal-muted')}>{p.exitReason ? EXIT_REASONS[p.exitReason] : '—'}</td>
                    <td className={cn(TD, 'font-medium')}><Money cents={p.realizedPnlUsd} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pages.hasMore && (
              <button type="button" onClick={pages.loadMore} disabled={pages.loading} data-testid="replay-load-more"
                className="m-3 px-3 py-1.5 rounded border border-terminal-border text-terminal-muted hover:text-[#e2e4e9] disabled:opacity-40">
                {pages.loading ? 'Loading…' : 'Load more'}
              </button>
            )}
            </>
          )
        )}
      </div>
    </div>
  );
}
