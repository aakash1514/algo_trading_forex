'use client';

import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { useOpenReplaySessionMutation } from '../../store/api/replay.api';
import { endedViewClosed, endedViewOpened, stateReceived, summaryDismissed } from '../../store/slices/replay.slice';
import { useReplaySocket } from '../../hooks/useReplaySocket';
import { replayErrorMessage } from '../../lib/replay';
import type { SessionListItem } from '../../types/replay.types';
import { EndSummaryCard } from './EndSummaryCard';
import { ReplayEndedView } from './ReplayEndedView';
import { ReplayScreen } from './ReplayScreen';
import { ReplaySessionList } from './ReplaySessionList';
import { ResumeCard } from './ResumeCard';
import { StartForm } from './StartForm';

// The Replay page. The socket's first 'state' is the user's current session (or none).
// The landing view shows it (Resume), the form for a new replay, and "My replays". The
// server decides what is current: opening a row asks it (POST /:id/open), which pauses a
// playing session first and answers with the session's state; an ENDED one is shown
// read-only. Creating a session connects again for its state (it is now the current one).
export function ReplayClient() {
  const dispatch = useAppDispatch();
  const socket = useReplaySocket();
  const loaded = useAppSelector((s) => s.replay.loaded);
  const connection = useAppSelector((s) => s.replay.connection);
  const hasSession = useAppSelector((s) => s.replay.session !== null);
  const readOnly = useAppSelector((s) => s.replay.readOnly);
  const summary = useAppSelector((s) => s.replay.summary);
  const [opened, setOpened] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);
  const [openSession] = useOpenReplaySessionMutation();

  async function open(sessionId: string) {
    setOpening(sessionId);
    setOpenError(null);
    const result = await openSession(sessionId);
    setOpening(null);
    if (!('data' in result) || !result.data) {
      setOpenError(replayErrorMessage(result.error));
      return;
    }
    if (result.data.session.status === 'ENDED') {
      dispatch(endedViewOpened(result.data));
    } else {
      dispatch(stateReceived(result.data));
      setOpened(true);
    }
  }
  const backToList = () => {
    setOpened(false);
    setListKey((k) => k + 1);
  };
  const leaveEndedView = () => {
    dispatch(endedViewClosed());
    socket.resync(); // the current session's state again
    backToList();
  };

  if (readOnly) return <ReplayEndedView onBack={leaveEndedView} />;
  if (summary) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <EndSummaryCard summary={summary} onDone={() => { dispatch(summaryDismissed()); backToList(); }} />
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="h-full overflow-y-auto p-4">
        {connection === 'failed' ? (
          <div role="alert" className="text-[12px] text-accent-red space-y-2">
            <p>Could not connect to the replay service — is replay-service running?</p>
            <button type="button" onClick={socket.retry} className="px-3 py-1.5 rounded border border-terminal-border text-[#e2e4e9]">
              Retry
            </button>
          </div>
        ) : <p role="status" className="text-[12px] text-terminal-muted">Connecting to the replay service…</p>}
      </div>
    );
  }
  if (hasSession && opened) {
    return <ReplayScreen socket={socket} onBack={backToList} onReopen={(id) => void open(id)} />;
  }
  return (
    <div className="h-full overflow-y-auto p-4 space-y-6">
      {hasSession && <ResumeCard onResume={() => setOpened(true)} />}
      <StartForm onCreated={() => { setOpened(true); socket.resync(); }} />
      {openError && <p role="alert" data-testid="replay-open-error" className="text-[12px] text-accent-red">{openError}</p>}
      <ReplaySessionList refreshKey={listKey} opening={opening} onOpen={(s: SessionListItem) => void open(s.id)} />
    </div>
  );
}
