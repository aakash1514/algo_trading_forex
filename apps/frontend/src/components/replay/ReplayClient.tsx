'use client';

import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { summaryDismissed } from '../../store/slices/replay.slice';
import { useReplaySocket } from '../../hooks/useReplaySocket';
import { EndSummaryCard } from './EndSummaryCard';
import { ReplayScreen } from './ReplayScreen';
import { ResumeCard } from './ResumeCard';
import { StartForm } from './StartForm';

// The Replay page. The socket's first 'state' says whether the user has an active
// session: none -> the start form; one -> the resume card, then the replay screen.
// Creating a session (or a 409 because one exists) connects again for its state.
export function ReplayClient() {
  const dispatch = useAppDispatch();
  const socket = useReplaySocket();
  const loaded = useAppSelector((s) => s.replay.loaded);
  const connection = useAppSelector((s) => s.replay.connection);
  const hasSession = useAppSelector((s) => s.replay.session !== null);
  const summary = useAppSelector((s) => s.replay.summary);
  const [opened, setOpened] = useState(false);

  let body: React.ReactNode;
  if (summary) {
    body = <EndSummaryCard summary={summary} onDone={() => { setOpened(false); dispatch(summaryDismissed()); }} />;
  } else if (!loaded) {
    body = connection === 'failed'
      ? (
        <div role="alert" className="text-[12px] text-accent-red space-y-2">
          <p>Could not connect to the replay service — is replay-service running?</p>
          <button type="button" onClick={socket.retry} className="px-3 py-1.5 rounded border border-terminal-border text-[#e2e4e9]">
            Retry
          </button>
        </div>
      )
      : <p role="status" className="text-[12px] text-terminal-muted">Connecting to the replay service…</p>;
  } else if (!hasSession) {
    body = (
      <StartForm
        onCreated={() => { setOpened(true); socket.resync(); }}
        onConflict={() => { setOpened(false); socket.resync(); }}
      />
    );
  } else if (!opened) {
    body = <ResumeCard onResume={() => setOpened(true)} />;
  } else {
    return <ReplayScreen socket={socket} />;
  }
  return <div className="h-full overflow-y-auto p-4">{body}</div>;
}
