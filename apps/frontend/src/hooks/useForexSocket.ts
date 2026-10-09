'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAppDispatch, useAppSelector } from '../store';
import { tickReceived } from '../store/slices/market.slice';
import { positionUpdated, setPositions } from '../store/slices/positions.slice';
import { setAccountSummary } from '../store/slices/account.slice';
import { signalReceived } from '../store/slices/signals.slice';
import { baseApi } from '../store/api/base.api';
import { WS_URL, MAJOR_PAIRS, SOCKET_EVENTS } from '../lib/constants';
import type {
  TickEvent,
  PositionUpdateEvent,
  PositionsSnapshotEvent,
  AccountUpdateEvent,
  SignalUpdateEvent,
} from '../types/api.types';

export function useForexSocket() {
  const dispatch = useAppDispatch();
  const accessToken = useAppSelector((s) => s.auth.accessToken);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    const socket = io(WS_URL, {
      auth: { token: accessToken },
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    socketRef.current = socket;

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
  }, [accessToken, dispatch]);

  return socketRef;
}