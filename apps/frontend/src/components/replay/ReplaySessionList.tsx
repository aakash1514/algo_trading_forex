'use client';

import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useDeleteReplaySessionMutation, useLazyGetReplaySessionsQuery, useRenameReplaySessionMutation,
} from '../../store/api/replay.api';
import { PAIR_DISPLAY } from '../../lib/constants';
import { cn } from '../../lib/cn';
import {
  formatReplayTime, formatUsd, replayErrorMessage, sessionStatusLabel, TITLE_MAX_CHARS, titleLength,
} from '../../lib/replay';
import type { SessionListItem } from '../../types/replay.types';

const TH = 'text-left px-3 py-2 text-[10px] text-terminal-muted uppercase tracking-wider font-medium whitespace-nowrap';
const TD = 'px-3 py-1.5 tabular-nums whitespace-nowrap';
const STATUS_STYLE: Record<string, string> = {
  Active: 'bg-accent-blue/15 text-accent-blue', Paused: 'bg-amber-400/15 text-amber-300', Ended: 'bg-terminal-elevated text-terminal-muted',
};

// The user's sessions, a page of 20 at a time from replay-service (last opened first),
// loaded again from the top whenever refreshKey changes (after an open, a create, an end,
// a rename or a delete): the server owns the order and the "current" flag.
function useSessionPages(refreshKey: number) {
  const [rows, setRows] = useState<SessionListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchPage, { isFetching }] = useLazyGetReplaySessionsQuery();

  const load = useCallback(async (after?: string) => {
    setError(null);
    const result = await fetchPage({ cursor: after, refreshKey });
    if (!result.data) {
      setError(replayErrorMessage(result.error));
      return;
    }
    const page = result.data;
    setRows((prev) => (after ? [...prev, ...page.sessions] : page.sessions));
    setCursor(page.nextCursor);
    setLoaded(true);
  }, [fetchPage, refreshKey]);

  useEffect(() => { void load(); }, [load]);

  return {
    rows, loaded, error, loading: isFetching, hasMore: cursor !== null,
    loadMore: () => { if (cursor) void load(cursor); },
    reload: () => load(),
  };
}

// The title as text, or an input while renaming: Enter or leaving the field saves, Esc
// cancels. The server checks the title; its refusal shows under the field.
function SessionTitle({ session, onRenamed }: { session: SessionListItem; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [problem, setProblem] = useState<string | null>(null);
  const [rename, { isLoading }] = useRenameReplaySessionMutation();

  const start = () => { setDraft(session.title); setProblem(null); setEditing(true); };
  const cancel = () => { setEditing(false); setProblem(null); };
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (isLoading) return;
    if (draft === session.title) return cancel();
    const result = await rename({ sessionId: session.id, title: draft });
    if ('data' in result) {
      setEditing(false);
      onRenamed();
    } else {
      setProblem(replayErrorMessage(result.error));
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span data-testid="replay-session-title" className="truncate text-[#e2e4e9] max-w-[22rem]" title={session.title}>
          {session.title}
        </span>
        <button type="button" onClick={start} aria-label={`Rename ${session.title}`}
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded text-terminal-muted hover:text-[#e2e4e9]">
          Rename
        </button>
      </div>
    );
  }
  const length = titleLength(draft);
  return (
    <form onSubmit={save} className="space-y-1" data-testid="replay-rename-form">
      <div className="flex items-center gap-1.5">
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
          onBlur={() => void save()} aria-label="Title" disabled={isLoading}
          className="w-64 bg-terminal-elevated border border-terminal-border rounded px-2 py-1 text-[12px] text-[#e2e4e9] focus:outline-none focus:border-accent-blue" />
        <span className={cn('text-[10px] tabular-nums', length > TITLE_MAX_CHARS ? 'text-accent-red' : 'text-terminal-muted')}>
          {length}/{TITLE_MAX_CHARS}
        </span>
      </div>
      <p className="text-[10px] text-terminal-muted">Enter saves, Esc cancels. Empty gives the automatic name.</p>
      {problem && <p role="alert" data-testid="replay-rename-error" className="text-[11px] text-accent-red">{problem}</p>}
    </form>
  );
}

// Delete, for an ENDED session only, behind a confirmation that names it
function DeleteSession({ session, onDeleted }: { session: SessionListItem; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [remove, { isLoading }] = useDeleteReplaySessionMutation();

  async function confirm() {
    setProblem(null);
    const result = await remove(session.id);
    if ('error' in result) {
      setProblem(replayErrorMessage(result.error));
      return;
    }
    setOpen(false);
    onDeleted();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!isLoading) { setOpen(next); setProblem(null); } }}>
      <Dialog.Trigger asChild>
        <button type="button" aria-label={`Delete ${session.title}`}
          className="text-[10px] px-2 py-1 rounded border border-accent-red/30 text-accent-red hover:bg-accent-red/10">
          Delete
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content role="alertdialog" data-testid="replay-delete-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-terminal-border bg-terminal-surface p-4 space-y-3 text-[12px] text-[#e2e4e9]">
          <Dialog.Title className="text-[13px] font-medium break-words">
            Delete &lsquo;{session.title}&rsquo;? This can&apos;t be undone.
          </Dialog.Title>
          <Dialog.Description className="text-terminal-muted">
            The replay and all its trades are deleted for good.
          </Dialog.Description>
          {problem && <p role="alert" className="text-accent-red">{problem}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" autoFocus disabled={isLoading}
                className="px-3 py-1.5 rounded border border-terminal-border text-terminal-muted hover:text-[#e2e4e9]">
                Cancel
              </button>
            </Dialog.Close>
            <button type="button" onClick={confirm} disabled={isLoading}
              className="px-3 py-1.5 rounded bg-accent-red text-white font-medium disabled:opacity-40">
              {isLoading ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// "My replays": every session of the user, last opened first. Titles are plain text
// (React text nodes only). Opening is the parent's (onOpen); an ENDED one opens read-only.
// Delete is offered on ENDED sessions only (the server refuses the others too).
export function ReplaySessionList({ refreshKey, onOpen, opening }: {
  refreshKey: number;
  onOpen: (session: SessionListItem) => void;
  opening: string | null;   // the id being opened: its button waits
}) {
  const pages = useSessionPages(refreshKey);

  return (
    <section data-testid="replay-session-list" className="space-y-2">
      <h2 className="text-[13px] font-medium text-[#e2e4e9]">My replays</h2>
      {pages.error && <p role="alert" data-testid="replay-sessions-error" className="text-[12px] text-accent-red">{pages.error}</p>}
      {!pages.loaded ? (
        !pages.error && <p className="text-[12px] text-terminal-muted">Loading…</p>
      ) : pages.rows.length === 0 ? (
        <p className="text-[12px] text-terminal-muted">No replays yet</p>
      ) : (
        <div className="overflow-x-auto border border-terminal-border rounded-lg bg-terminal-surface">
          <table className="w-full text-[11px]">
            <thead><tr className="border-b border-terminal-border">
              {['Title', 'Pair', 'Timeframe', 'Status', 'Replay time', 'Net P&L (closed trades)', 'Last opened', ''].map((h) => (
                <th key={h} className={TH}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {pages.rows.map((s) => {
                const label = sessionStatusLabel(s);
                return (
                  <tr key={s.id} data-testid="replay-session-row" data-id={s.id} className="border-b border-terminal-border/50">
                    <td className={cn(TD, 'whitespace-normal')}><SessionTitle session={s} onRenamed={pages.reload} /></td>
                    <td className={cn(TD, 'text-[#e2e4e9]')}>{PAIR_DISPLAY[s.instrument] ?? s.instrument}</td>
                    <td className={cn(TD, 'text-terminal-muted')}>{s.timeframe}</td>
                    <td className={TD}>
                      <span data-testid="replay-session-status" className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', STATUS_STYLE[label])}>
                        {label}
                      </span>
                    </td>
                    <td className={cn(TD, 'text-[#e2e4e9]')}>{formatReplayTime(s.clockTime)}</td>
                    <td className={cn(TD, 'font-medium', s.netPnlUsd.startsWith('-') ? 'text-accent-red' : 'text-accent-green')}
                      data-testid="replay-session-net">
                      {formatUsd(s.netPnlUsd, true)}
                    </td>
                    <td className={cn(TD, 'text-terminal-muted')}>{formatReplayTime(s.lastOpenedAt)}</td>
                    <td className={cn(TD, 'text-right space-x-2')}>
                      <button type="button" onClick={() => onOpen(s)} disabled={opening !== null}
                        aria-label={`${label === 'Ended' ? 'View' : 'Open'} ${s.title}`}
                        className="text-[10px] px-2 py-1 rounded bg-accent-blue/90 text-white font-medium disabled:opacity-40">
                        {opening === s.id ? 'Opening…' : label === 'Ended' ? 'View' : 'Open'}
                      </button>
                      {s.status === 'ENDED' && <DeleteSession session={s} onDeleted={pages.reload} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pages.hasMore && (
            <button type="button" onClick={pages.loadMore} disabled={pages.loading} data-testid="replay-sessions-load-more"
              className="m-3 px-3 py-1.5 rounded border border-terminal-border text-[11px] text-terminal-muted hover:text-[#e2e4e9] disabled:opacity-40">
              {pages.loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
