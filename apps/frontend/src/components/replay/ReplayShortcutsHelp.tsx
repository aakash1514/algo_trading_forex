'use client';

export const REPLAY_SHORTCUTS: readonly [string, string][] = [
  ['Space', 'Play / pause'],
  ['→', 'Step 1 bar (paused)'],
  ['Shift + →', 'Step 10 bars (paused)'],
  ['↑ / ↓', 'Faster / slower'],
  ['B / S', 'Order form with Buy / Sell chosen (you still confirm)'],
  ['?', 'Show / hide this list'],
  ['Esc', 'Close this list or the End-session question'],
];

// The keyboard shortcuts, over the chart's corner. Not a modal dialog: the keys keep
// working while it is open, so they can be tried out.
export function ReplayShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <section role="region" aria-label="Keyboard shortcuts" data-testid="replay-shortcuts-help"
      className="absolute right-3 top-3 z-10 w-72 rounded border border-terminal-border bg-terminal-surface p-3 shadow-lg text-[12px]">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider">Keyboard shortcuts</p>
        <button type="button" onClick={onClose} title="Close (Esc)"
          className="text-terminal-muted hover:text-[#e2e4e9] text-[11px]">Close</button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {REPLAY_SHORTCUTS.map(([key, what]) => (
          <div key={key} className="contents">
            <dt><kbd className="px-1.5 py-0.5 rounded border border-terminal-border bg-terminal-elevated text-[11px] text-[#e2e4e9]">{key}</kbd></dt>
            <dd className="text-terminal-muted">{what}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-terminal-muted">Keys do nothing while you type in a field or a command is running.</p>
    </section>
  );
}
