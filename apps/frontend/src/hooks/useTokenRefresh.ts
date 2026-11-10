'use client';

import { useEffect } from 'react';
import { useStore } from 'react-redux';
import { useAppSelector, type RootState } from '../store';
import { sessionExpired, setCredentials } from '../store/slices/auth.slice';
import { refreshSession, tokenExpiresAt } from '../lib/session';

// Refresh the access token shortly before it expires, so the open sockets get a fresh one
// before the servers' expiry deadline (the replay socket sends it as a reauth; ws-gateway's socket
// reads it at its next connect) and REST calls don't hit a 401 first.
export const REFRESH_LEAD_MS = 60_000;

// When to refresh a token that expires at expiresAtMs: a minute before, or halfway for a token
// with less than two minutes left, so a short-lived token can't trigger a refresh loop.
export function refreshDelayMs(expiresAtMs: number, nowMs: number): number {
  const left = expiresAtMs - nowMs;
  return Math.max(0, left - Math.min(REFRESH_LEAD_MS, left / 2));
}

export function useTokenRefresh(): void {
  const store = useStore<RootState>();
  const token = useAppSelector((s) => s.auth.accessToken);

  useEffect(() => {
    const expiresAt = tokenExpiresAt(token);
    if (!token || expiresAt === null) return;
    const timer = setTimeout(async () => {
      const session = await refreshSession();
      // A login, logout or another refresh replaced the token meanwhile: that one wins
      if (store.getState().auth.accessToken !== token) return;
      store.dispatch(session ? setCredentials(session) : sessionExpired());
    }, refreshDelayMs(expiresAt, Date.now()));
    return () => clearTimeout(timer);
  }, [store, token]);
}
