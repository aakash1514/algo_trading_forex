'use client';

import { useState } from 'react';
import { useAppDispatch } from '../../store';
import { useEndReplaySessionMutation } from '../../store/api/replay.api';
import { sessionEnded } from '../../store/slices/replay.slice';
import { replayErrorMessage } from '../../lib/replay';

// "End session" with a confirmation on the page (no browser dialog): ending closes the
// open positions at the replay clock's price and cancels pending orders.
export function EndSession({ openPositions, pendingOrders }: { openPositions: number; pendingOrders: number }) {
  const dispatch = useAppDispatch();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [end, { isLoading }] = useEndReplaySessionMutation();

  async function confirm() {
    setError(null);
    const result = await end();
    if ('data' in result && result.data) dispatch(sessionEnded(result.data));
    else setError(replayErrorMessage(result.error));
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="px-3 py-1.5 rounded border border-accent-red/40 text-accent-red text-[12px] font-medium hover:bg-accent-red/10">
        End session
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label="End the replay session" data-testid="replay-end-confirm"
      className="rounded border border-accent-red/40 bg-accent-red/10 p-3 space-y-2 text-[12px] text-[#e2e4e9]">
      <p>
        End this replay? {openPositions > 0
          ? `Your ${openPositions} open position${openPositions === 1 ? '' : 's'} will be closed at the current replay price`
          : 'No position is open'}
        {pendingOrders > 0 ? ` and ${pendingOrders} pending order${pendingOrders === 1 ? '' : 's'} cancelled` : ''}.
        This can&apos;t be undone.
      </p>
      {error && <p role="alert" className="text-accent-red">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={confirm} disabled={isLoading}
          className="px-3 py-1.5 rounded bg-accent-red text-white font-medium disabled:opacity-40">
          {isLoading ? 'Ending…' : 'Yes, end the session'}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={isLoading}
          className="px-3 py-1.5 rounded border border-terminal-border text-terminal-muted hover:text-[#e2e4e9]">
          Keep replaying
        </button>
      </div>
    </div>
  );
}
