'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { useAppSelector, type RootState } from '../store';
import type { ReplaySliceState } from '../store/slices/replay.slice';
import type { Timeframe } from '../lib/constants';
import { adjacentSpeed } from '../lib/replay';
import type { StepResult } from '../types/replay.types';
import type { ReplaySocket } from './useReplaySocket';

// Shift+→ and the "Step 10" button
export const STEP_MANY_BARS = 10;

type CommandState = Pick<ReplaySliceState, 'connection' | 'loaded' | 'session' | 'pendingCommand'>;

// A command can go out: connected, a live session, nothing waiting for its acknowledgement
function commandAllowed(r: CommandState): boolean {
  return r.connection === 'connected' && r.loaded && r.session !== null && r.session.status !== 'ENDED'
    && r.pendingCommand === null;
}

function stepAllowed(r: CommandState): boolean {
  return commandAllowed(r) && r.session?.status === 'PAUSED' && !r.session.endOfData;
}

export interface ReplayActions {
  // Nothing in flight on a connected, live session (the keyboard shortcuts' first check)
  ready: boolean;
  playing: boolean;
  steppingMany: boolean;
  canPlayPause: boolean;
  canStep: boolean;
  canChange: boolean;            // speed and timeframe buttons
  canFaster: boolean;
  canSlower: boolean;
  playPause: () => void;
  step: () => void;
  stepMany: () => Promise<void>;
  setSpeed: (speedMs: number) => void;
  faster: () => void;
  slower: () => void;
  setTimeframe: (timeframe: Timeframe) => void;
}

// What each playback control may do now and the one handler it calls. The buttons
// (ReplayControls) and the keyboard shortcuts (useReplayShortcuts) both use this, so a
// key always does exactly what its button does, and nothing when the button is disabled.
// Created once per replay screen: the "10 steps running" flag is shared by both.
export function useReplayActions(socket: ReplaySocket): ReplayActions {
  const store = useStore<RootState>();
  const connection = useAppSelector((s) => s.replay.connection);
  const loaded = useAppSelector((s) => s.replay.loaded);
  const session = useAppSelector((s) => s.replay.session);
  const pending = useAppSelector((s) => s.replay.pendingCommand);
  const [steppingMany, setSteppingMany] = useState(false);
  const runningRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const send = useCallback((name: Parameters<ReplaySocket['command']>[0], body?: Record<string, unknown>) => {
    void socket.command(name, body);
  }, [socket]);

  // Up to 10 single steps, each after the previous one's acknowledgement (replay-service
  // steps one bar per command). Stops at a refusal, the end of the data, a lost
  // connection or ended session, or when the replay screen goes away.
  const stepMany = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setSteppingMany(true);
    try {
      for (let i = 0; i < STEP_MANY_BARS; i += 1) {
        if (!aliveRef.current || !stepAllowed(store.getState().replay)) break;
        const ack = await socket.command('step');
        if (!ack.ok || (ack.result as StepResult).endOfData) break;
      }
    } finally {
      runningRef.current = false;
      if (aliveRef.current) setSteppingMany(false);
    }
  }, [socket, store]);

  const speedMs = session?.speedMs ?? 0;
  const setSpeed = useCallback((ms: number) => send('setSpeed', { speedMs: ms }), [send]);
  const faster = useCallback(() => {
    const next = adjacentSpeed(speedMs, 'faster');
    if (next !== null) setSpeed(next);
  }, [speedMs, setSpeed]);
  const slower = useCallback(() => {
    const next = adjacentSpeed(speedMs, 'slower');
    if (next !== null) setSpeed(next);
  }, [speedMs, setSpeed]);

  const playing = session?.status === 'PLAYING';
  const playPause = useCallback(() => send(playing ? 'pause' : 'play'), [send, playing]);
  const step = useCallback(() => send('step'), [send]);
  const setTimeframe = useCallback((timeframe: Timeframe) => send('setTimeframe', { timeframe }), [send]);

  return useMemo(() => {
    const now = { connection, loaded, session, pendingCommand: pending };
    const ready = commandAllowed(now) && !steppingMany;
    return {
      ready,
      playing,
      steppingMany,
      canPlayPause: ready && (playing || !session?.endOfData),
      canStep: ready && stepAllowed(now),
      canChange: ready,
      canFaster: ready && adjacentSpeed(speedMs, 'faster') !== null,
      canSlower: ready && adjacentSpeed(speedMs, 'slower') !== null,
      playPause, step, stepMany, setSpeed, faster, slower, setTimeframe,
    };
  }, [connection, loaded, session, pending, steppingMany, playing, speedMs,
    playPause, step, stepMany, setSpeed, faster, slower, setTimeframe]);
}
