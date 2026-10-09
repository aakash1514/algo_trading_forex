'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAppDispatch, useAppSelector } from '../store';
import { tickReceived } from '../store/slices/market.slice';
import { positionUpdated, setPositions } from '../store/slices/positions.slice';
import { accountUpdated, setAccountSummary } from '../store/slices/account.slice';
import { signalReceived } from '../store/slices/signals.slice';
import { WS_URL, MAJOR_PAIRS } from '../lib/constants';
import type {
  TickEvent,
  PositionUpdateEvent,
  AccountUpdateEvent,
  SignalUpdateEvent,
  AccountSummary,
  Position,
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

    // Position P&L updates → positions slice
    socket.on('position:update', (data: PositionUpdateEvent) => {
      dispatch(positionUpdated(data));
    });

    // Account equity/margin updates → account slice
    socket.on('account:update', (data: AccountUpdateEvent) => {
      dispatch(accountUpdated(data));
    });

    // ML signals → signals slice
    socket.on('signal:update', (data: SignalUpdateEvent) => {
      dispatch(signalReceived(data));
    });

   return () => {
  MAJOR_PAIRS.forEach((pair) => {
    socket.emit('unsubscribe:ticker', pair);  // plain string here too
  });
  socket.disconnect();
  socketRef.current = null;
};
  }, [accessToken, dispatch]);

  return socketRef;
}