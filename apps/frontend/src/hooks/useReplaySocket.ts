'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'react-redux';
import { io, type Socket } from 'socket.io-client';
import { useAppDispatch, type RootState } from '../store';
import {
  accountReceived, barReceived, calendarReceived, commandFinished, commandStarted, connectionChanged, endOfDataReceived, errorReceived,
  positionsReceived, replayReset, sessionEnded, stateReceived, stateUpdated, statusReceived,
} from '../store/slices/replay.slice';
import { REPLAY_SOCKET_PATH, REPLAY_WS_URL } from '../lib/constants';
import { AUTH_EXPIRED_EVENT, REAUTH_EVENT, renewSessionForSocket } from '../lib/socket-auth';
import type {
  BarEvent, CalendarMessage, CommandAck, EndedSession, EndOfDataEvent, ReplayAccount, ReplayPosition, ReplaySession, ReplayState,
} from '../types/replay.types';

export const COMMAND_TIMEOUT_MS = 10_000;
const RECONNECT_ATTEMPTS = 10;

export type ReplayCommand = 'play' | 'pause' | 'step' | 'setSpeed' | 'setTimeframe';

export interface ReplaySocket {
  // Sends a command for the session this page shows ({ sessionId, ...body }) and waits for
  // its acknowledgement; the page's controls stay disabled meanwhile (replay.pendingCommand)
  command: (name: ReplayCommand, body?: Record<string, unknown>) => Promise<CommandAck>;
  // Connects again to get a fresh 'state' (after creating a session)
  resync: () => void;
  // Starts over after the reconnect attempts ran out
  retry: () => void;
}

// One Socket.IO connection to replay-service's /replay for as long as the page is open.
//
// The token is read from the store each time the socket (re)connects, never captured:
// a token refreshed by an API call is simply used next time, and the socket isn't torn
// down when it changes (a disconnect would pause the replay as DISCONNECT).
// replay-service holds the socket to its token's expiry: whenever the store gets a new
// token (useTokenRefresh refreshes a minute before expiry), the hook sends it as a
// 'reauth', which moves the server's deadline, so the socket (and a playing replay)
// carries on. If the deadline passes anyway, the server emits authExpired and closes the
// socket (the replay pauses as DISCONNECT); a refused handshake is replayError
// 'Unauthorized'. Either way the hook runs the app's shared refresh once (one in flight
// across tabs, the refresh token rotates) and connects again with the new token; if the
// refresh fails the session is over (the login page says so) and nothing reconnects.
// The server always sends a PAUSED state on connect, and nothing here ever sends
// 'play' by itself. That first 'state' after a connect (sent to this socket only) shows
// the user's current session; a later 'state' is a broadcast (a timeframe change) and only
// updates the session this page already shows. Every command names that session.
export function useReplaySocket(): ReplaySocket {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(REPLAY_WS_URL, {
      path: REPLAY_SOCKET_PATH,
      auth: (cb) => cb({ token: store.getState().auth.accessToken ?? '' }),
      transports: ['websocket'],
      reconnectionAttempts: RECONNECT_ATTEMPTS,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;
    dispatch(connectionChanged('connecting'));
    let refreshedSinceConnect = false;
    let expiredByServer = false;

    // Renews the session once, then connects again; a failure ends the session (no loop)
    const renewAndConnect = async () => {
      if (refreshedSinceConnect) {
        dispatch(connectionChanged('failed'));
        return;
      }
      refreshedSinceConnect = true;
      if (await renewSessionForSocket(dispatch)) socket.connect();
    };

    // A new token while connected: hand it to the server before the old one expires
    let lastToken = store.getState().auth.accessToken;
    const unsubscribe = store.subscribe(() => {
      const token = store.getState().auth.accessToken;
      if (token === lastToken) return;
      lastToken = token;
      if (token && socket.connected) {
        socket.timeout(COMMAND_TIMEOUT_MS).emitWithAck(REAUTH_EVENT, { token }).catch(() => undefined);
      }
    });

    let awaitingConnectState = true;
    socket.on('connect', () => {
      awaitingConnectState = true;
      dispatch(connectionChanged('connected'));
    });
    socket.on('disconnect', (reason) => {
      // 'io client disconnect': this page closed it (leaving, or a resync)
      // 'io server disconnect': closed by the server: its token expired (authExpired came
      //   first) or was refused at the handshake (handled on replayError)
      // anything else: the connection dropped and socket.io reconnects by itself
      if (reason === 'io client disconnect') return;
      dispatch(connectionChanged(reason === 'io server disconnect' ? 'connecting' : 'reconnecting'));
      if (reason === 'io server disconnect' && expiredByServer) {
        expiredByServer = false;
        void renewAndConnect();
      }
    });
    socket.on(AUTH_EXPIRED_EVENT, () => {
      expiredByServer = true;
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
      await renewAndConnect();
    });

    socket.on('state', (payload: ReplayState | { session: null }) => {
      refreshedSinceConnect = false;
      if (awaitingConnectState) {
        awaitingConnectState = false;
        dispatch(stateReceived(payload.session ? (payload as ReplayState) : null));
      } else if (payload.session) {
        dispatch(stateUpdated(payload as ReplayState));
      }
    });
    socket.on('bar', (payload: BarEvent) => dispatch(barReceived(payload)));
    socket.on('calendar', (payload: CalendarMessage) => dispatch(calendarReceived(payload)));
    socket.on('account', (payload: ReplayAccount) => dispatch(accountReceived(payload)));
    socket.on('positions', (payload: ReplayPosition[]) => dispatch(positionsReceived(payload)));
    socket.on('status', (payload: ReplaySession) => dispatch(statusReceived(payload)));
    socket.on('endOfData', (payload: EndOfDataEvent) => dispatch(endOfDataReceived(payload)));
    socket.on('ended', (payload: EndedSession) => dispatch(sessionEnded(payload)));

    return () => {
      unsubscribe();
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
      const sessionId = store.getState().replay.session?.id;
      ack = await socket.timeout(COMMAND_TIMEOUT_MS).emitWithAck(name, { ...body, sessionId });
    } catch {
      ack = { ok: false, error: 'The replay service did not answer in time' };
    }
    dispatch(commandFinished(ack.ok ? null : ack.error));
    return ack;
  }, [dispatch, store]);

  const resync = useCallback(() => {
    socketRef.current?.disconnect().connect();
  }, []);

  const retry = useCallback(() => {
    dispatch(connectionChanged('connecting'));
    socketRef.current?.connect();
  }, [dispatch]);

  return useMemo(() => ({ command, resync, retry }), [command, resync, retry]);
}
