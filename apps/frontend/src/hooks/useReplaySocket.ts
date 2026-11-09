'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'react-redux';
import { io, type Socket } from 'socket.io-client';
import { useAppDispatch, type RootState } from '../store';
import { clearCredentials, setCredentials } from '../store/slices/auth.slice';
import {
  accountReceived, barReceived, commandFinished, commandStarted, connectionChanged, endOfDataReceived, errorReceived,
  positionsReceived, replayReset, sessionEnded, stateReceived, statusReceived,
} from '../store/slices/replay.slice';
import { REPLAY_WS_URL } from '../lib/constants';
import { refreshSession } from '../lib/session';
import type {
  BarEvent, CommandAck, EndedSession, EndOfDataEvent, ReplayAccount, ReplayPosition, ReplaySession, ReplayState,
} from '../types/replay.types';

export const COMMAND_TIMEOUT_MS = 10_000;
const RECONNECT_ATTEMPTS = 10;

export type ReplayCommand = 'play' | 'pause' | 'step' | 'setSpeed' | 'setTimeframe';

export interface ReplaySocket {
  // Sends a command and waits for its acknowledgement; the page's controls stay
  // disabled meanwhile (replay.pendingCommand)
  command: (name: ReplayCommand, body?: Record<string, unknown>) => Promise<CommandAck>;
  // Connects again to get a fresh 'state' (after creating a session, or a 409)
  resync: () => void;
  // Starts over after the reconnect attempts ran out
  retry: () => void;
}

// One Socket.IO connection to replay-service's /replay for as long as the page is open.
//
// The token is read from the store each time the socket (re)connects, never captured:
// a token refreshed by an API call is simply used next time, and the socket isn't torn
// down when it changes (a disconnect would pause the replay as DISCONNECT).
// The server refuses an expired token by emitting replayError 'Unauthorized' and
// closing the socket; the hook then runs the app's shared refresh (one in flight for
// the whole app, the refresh token rotates) and connects again with the new token.
// The server always sends a PAUSED state on connect, and nothing here ever sends
// 'play' by itself.
export function useReplaySocket(): ReplaySocket {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(REPLAY_WS_URL, {
      auth: (cb) => cb({ token: store.getState().auth.accessToken ?? '' }),
      transports: ['websocket'],
      reconnectionAttempts: RECONNECT_ATTEMPTS,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;
    dispatch(connectionChanged('connecting'));
    let refreshedSinceConnect = false;

    socket.on('connect', () => dispatch(connectionChanged('connected')));
    socket.on('disconnect', (reason) => {
      // 'io client disconnect': this page closed it (leaving, or a resync)
      // 'io server disconnect': refused by the server (handled on replayError)
      // anything else: the connection dropped and socket.io reconnects by itself
      if (reason === 'io client disconnect') return;
      dispatch(connectionChanged(reason === 'io server disconnect' ? 'connecting' : 'reconnecting'));
    });
    socket.on('connect_error', () => {
      dispatch(connectionChanged(socket.active ? 'reconnecting' : 'failed'));
    });
    socket.io.on('reconnect_failed', () => dispatch(connectionChanged('failed')));

    socket.on('replayError', async (payload: { error?: string }) => {
      if (payload?.error !== 'Unauthorized') {
        dispatch(errorReceived(payload?.error ?? 'Replay error'));
        return;
      }
      // One refresh per refusal: a second refusal right after a fresh token is final
      if (refreshedSinceConnect) {
        dispatch(connectionChanged('failed'));
        return;
      }
      refreshedSinceConnect = true;
      const session = await refreshSession();
      if (!session) {
        dispatch(clearCredentials()); // AuthGuard sends the user to /login
        return;
      }
      dispatch(setCredentials(session));
      socket.connect();
    });

    socket.on('state', (payload: ReplayState | { session: null }) => {
      refreshedSinceConnect = false;
      dispatch(stateReceived(payload.session ? (payload as ReplayState) : null));
    });
    socket.on('bar', (payload: BarEvent) => dispatch(barReceived(payload)));
    socket.on('account', (payload: ReplayAccount) => dispatch(accountReceived(payload)));
    socket.on('positions', (payload: ReplayPosition[]) => dispatch(positionsReceived(payload)));
    socket.on('status', (payload: ReplaySession) => dispatch(statusReceived(payload)));
    socket.on('endOfData', (payload: EndOfDataEvent) => dispatch(endOfDataReceived(payload)));
    socket.on('ended', (payload: EndedSession) => dispatch(sessionEnded(payload)));

    return () => {
      socket.removeAllListeners();
      socket.io.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      dispatch(replayReset());
    };
  }, [dispatch, store]);

  const command = useCallback(async (name: ReplayCommand, body?: Record<string, unknown>): Promise<CommandAck> => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      const ack: CommandAck = { ok: false, error: 'Not connected to the replay service' };
      dispatch(commandFinished(ack.error));
      return ack;
    }
    dispatch(commandStarted(name));
    let ack: CommandAck;
    try {
      ack = await socket.timeout(COMMAND_TIMEOUT_MS).emitWithAck(name, body ?? {});
    } catch {
      ack = { ok: false, error: 'The replay service did not answer in time' };
    }
    dispatch(commandFinished(ack.ok ? null : ack.error));
    return ack;
  }, [dispatch]);

  const resync = useCallback(() => {
    socketRef.current?.disconnect().connect();
  }, []);

  const retry = useCallback(() => {
    dispatch(connectionChanged('connecting'));
    socketRef.current?.connect();
  }, [dispatch]);

  return useMemo(() => ({ command, resync, retry }), [command, resync, retry]);
}
