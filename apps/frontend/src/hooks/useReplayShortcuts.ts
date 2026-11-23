'use client';

import { useEffect, useEffectEvent, type RefObject } from 'react';
import type { OrderPanelHandle } from '../components/replay/ReplayOrderPanel';
import type { ReplayActions } from './useReplayActions';

export interface ReplayShortcutTargets {
  actions: ReplayActions;
  orderPanel: RefObject<OrderPanelHandle | null>;
  helpOpen: boolean;
  toggleHelp: () => void;
  closeHelp: () => void;
}

// Where keys belong to what the user is typing or deciding, not to the replay
const TYPING_OR_DIALOG = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), form, '
  + '[role="dialog"], [role="alertdialog"]';
// Space activates these by itself (a click on key up); handling it too would toggle twice
const SPACE_ACTIVATES = 'button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="tab"]';

// The Replay page's keyboard shortcuts, on the window while the replay screen is mounted:
//   Space play/pause · → step 1 bar · Shift+→ step 10 bars · ↑ faster · ↓ slower
//   B / S the order form with Buy / Sell chosen and the cursor in Lots (never an order)
//   ? the shortcuts panel · Esc closes it (the End-session confirmation handles its own Esc)
// Each key calls its button's handler from useReplayActions and does nothing when that
// button is disabled. Keys are left alone (no preventDefault) unless handled, while typing
// in a field or form, while a dialog is open, with Ctrl/Meta/Alt (browser shortcuts), during
// IME composition, for auto-repeat (holding a key must not flood the socket), and unless
// a command can go out now (connected, live session, nothing in flight).
export function useReplayShortcuts(targets: ReplayShortcutTargets): void {
  // An effect event: the listener below is added once, and this always sees the latest
  // render's actions and help state
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
    const { actions, orderPanel, helpOpen, toggleHelp, closeHelp } = targets;
    if (e.key === 'Escape') {
      if (helpOpen) closeHelp();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(TYPING_OR_DIALOG)) return;
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    if (!actions.ready) return;

    let run: (() => void) | null = null;
    switch (e.key) {
      case ' ':
        if (!target?.closest(SPACE_ACTIVATES) && actions.canPlayPause) run = actions.playPause;
        break;
      case 'ArrowRight':
        if (actions.canStep) run = e.shiftKey ? () => { void actions.stepMany(); } : actions.step;
        break;
      case 'ArrowUp':
        if (actions.canFaster) run = actions.faster;
        break;
      case 'ArrowDown':
        if (actions.canSlower) run = actions.slower;
        break;
      case 'b':
      case 'B':
      case 's':
      case 'S': {
        const panel = orderPanel.current;
        // preventDefault matters here: focus moves to Lots during this keydown, and the
        // letter would otherwise be typed into it
        if (panel) run = () => panel.prepare(e.key.toLowerCase() === 'b' ? 'BUY' : 'SELL');
        break;
      }
      case '?':
        run = toggleHelp;
        break;
    }
    if (!run) return;
    e.preventDefault();
    run();
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyDown(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
