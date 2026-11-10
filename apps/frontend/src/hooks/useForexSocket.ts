'use client';

import { useEffect, useRef } from 'react';
import { useStore } from 'react-redux';
import { io, type Socket } from 'socket.io-client';
import { useAppDispatch, useAppSelector, type RootState } from '../store';
import { tickReceived } from '../store/slices/market.slice';
import { positionUpdated, setPositions } from '../store/slices/positions.slice';
import { setAccountSummary } from '../store/slices/account.slice';
import { signalReceived } from '../store/slices/signals.slice';
import { baseApi } from '../store/api/base.api';
import { WS_URL, MAJOR_PAIRS, SOCKET_EVENTS } from '../lib/constants';
import { renewSessionForSocket } from '../lib/socket-auth';
import type {
  TickEvent,
  PositionUpdateEvent,
  PositionsSnapshotEvent,
  AccountUpdateEvent,
  SignalUpdateEvent,
} from '../types/api.types';

// A refused or expired token is renewed at most once in this window; a second refusal right after a
// fresh token (a secret mismatch, a clock far off) stops instead of looping refresh → connect → refuse.
export const RENEW_WINDOW_MS = 30_000;

// One Socket.IO connection to ws-gateway while signed in. The token is read from the store at each
// (re)connect, never captured, so a token refresh doesn't tear the socket down.
// ws-gateway closes the socket when its token expires (authExpired, then a server disconnect, after
// which socket.io doesn't reconnect by itself): the hook renews the session once and connects again
// with the fresh token, resubscribing to the tickers on connect. If the refresh fails, the session is
// over: the login page says so, and nothing reconnects.
export function useForexSocket() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    const socket = io(WS_URL, {
      auth: (cb) => cb({ token: store.getState().auth.accessToken ?? '' }),
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    socketRef.current = socket;
    let lastRenewAt = -Infinity;
    let stopped = false;

    socket.on('disconnect', async (reason) => {
      // Only a server-side close needs us: other drops reconnect by themselves
      if (reason !== 'io server disconnect' || stopped) return;
      if (Date.now() - lastRenewAt < RENEW_WINDOW_MS) {
        stopped = true; // refused again right after a fresh token: no loop
        return;
      }
      lastRenewAt = Date.now();
      if (await renewSessionForSocket(dispatch)) socket.connect();
      else stopped = true;
    });

    socket.on('connect', () => {
      // Subscribe to all major pairs on connect
      MAJOR_PAIRS.forEach((pair) => {
        socket.emit('subscribe:ticker', pair);
      });
    });

    // Live tick prices → market slice
    MAJOR_PAIRS.forEach((pair) => {
      socket.on(`tick:${pair}`, (tick: TickEvent) => {
        dispatch(tickReceived({ instrument: pair, tick }));
      });
    });

    // Tick-driven P&L for one position (~1/s per position)
    socket.on(SOCKET_EVENTS.POSITION_UPDATE, (data: PositionUpdateEvent) => {
      dispatch(positionUpdated(data));
    });

    // Full open-position list after an order fills or a position closes
    socket.on(SOCKET_EVENTS.POSITIONS_SNAPSHOT, (positions: PositionsSnapshotEvent) => {
      dispatch(setPositions(positions));
    });

    // Full account summary after order/position changes (~1/s while P&L moves)
    socket.on(SOCKET_EVENTS.ACCOUNT_UPDATE, (summary: AccountUpdateEvent) => {
      dispatch(setAccountSummary(summary));
    });

    // Order lifecycle changes: refetch any cached order lists
    socket.on(SOCKET_EVENTS.ORDER_UPDATE, () => {
      dispatch(baseApi.util.invalidateTags(['Orders']));
    });

    // ML signals → signals slice
    socket.on('signal:update', (data: SignalUpdateEvent) => {
      dispatch(signalReceived(data));
    });

    return () => {
      MAJOR_PAIRS.forEach((pair) => {
        socket.emit('unsubscribe:ticker', pair);
      });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated, dispatch, store]);

  return socketRef;
}