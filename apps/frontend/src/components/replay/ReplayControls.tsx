'use client';

import { useAppSelector } from '../../store';
import type { ReplaySocket } from '../../hooks/useReplaySocket';
import type { ReplayActions } from '../../hooks/useReplayActions';
import { cn } from '../../lib/cn';
import { REPLAY_SPEEDS, REPLAY_TIMEFRAMES, statusMessage } from '../../lib/replay';

const BUTTON = 'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const OFF = 'border-terminal-border text-terminal-muted hover:text-[#e2e4e9]';
const ON = 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue';

// Play/pause, step, speed and timeframe. What each button may do and the handler it
// calls come from useReplayActions (shared with the keyboard shortcuts): every button is
// disabled while a command waits for its acknowledgement, during a 10-bar step, and while
// the socket isn't connected. The title shows each button's key.
export function ReplayControls({ socket, actions }: { socket: ReplaySocket; actions: ReplayActions }) {
  const session = useAppSelector((s) => s.replay.session);
  const connection = useAppSelector((s) => s.replay.connection);
  const error = useAppSelector((s) => s.replay.error);
  if (!session) return null;

  const { playing } = actions;

  let status: string;
  let tone = 'text-terminal-muted';
  if (connection === 'reconnecting') [status, tone] = ['Reconnecting…', 'text-amber-300'];
  else if (connection === 'connecting') [status, tone] = ['Connecting…', 'text-amber-300'];
  else if (connection === 'failed' || connection === 'closed') [status, tone] = ['Connection lost', 'text-accent-red'];
  else {
    status = statusMessage(session);
    if (playing) tone = 'text-accent-green';
    else if (session.pauseReason && session.pauseReason !== 'USER') tone = 'text-amber-300';
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-terminal-border bg-terminal-surface shrink-0">
      <button type="button" data-testid="replay-play" disabled={!actions.canPlayPause}
        onClick={actions.playPause} title={playing ? 'Pause (Space)' : 'Play (Space)'}
        className={cn(BUTTON, playing ? ON : 'border-accent-green/40 text-accent-green hover:bg-accent-green/10', 'min-w-16')}>
        {playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <button type="button" data-testid="replay-step" disabled={!actions.canStep}
        onClick={actions.step} title="Step 1 bar (→)" className={cn(BUTTON, OFF)}>
        Step ▸|
      </button>
      <button type="button" data-testid="replay-step-many" disabled={!actions.canStep}
        onClick={() => { void actions.stepMany(); }} title="Step 10 bars (Shift+→)" className={cn(BUTTON, OFF)}>
        Step 10 ▸▸
      </button>

      <div className="flex items-center gap-1" role="group" aria-label="Speed (seconds per bar)">
        <span className="text-[10px] text-terminal-muted uppercase tracking-wider mr-1">Speed</span>
        {REPLAY_SPEEDS.map(({ ms, label }) => (
          <button key={ms} type="button" disabled={!actions.canChange} aria-pressed={session.speedMs === ms}
            onClick={() => actions.setSpeed(ms)} title={`${label} per bar (↑ faster, ↓ slower)`} className={cn(BUTTON, session.speedMs === ms ? ON : OFF)}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Timeframe">
        <span className="text-[10px] text-terminal-muted uppercase tracking-wider mr-1">Bars</span>
        {REPLAY_TIMEFRAMES.map((tf) => (
          <button key={tf} type="button" disabled={!actions.canChange} aria-pressed={session.timeframe === tf}
            onClick={() => actions.setTimeframe(tf)} className={cn(BUTTON, session.timeframe === tf ? ON : OFF)}>
            {tf}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2 text-[12px]">
        {connection === 'failed' && (
          <button type="button" onClick={socket.retry} className={cn(BUTTON, OFF)}>Retry</button>
        )}
        <span role="status" data-testid="replay-status" className={cn('font-medium', tone)}>{status}</span>
      </div>
      {error && <p role="alert" data-testid="replay-command-error" className="basis-full text-[12px] text-accent-red">{error}</p>}
    </div>
  );
}
