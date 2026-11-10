import { API_BASE } from './constants';
import type { AuthUser } from '../types/api.types';

export interface SessionTokens {
  accessToken: string;
  user: AuthUser;
}

// The refresh token is an httpOnly cookie that auth-service rotates on every use: it keeps one
// refresh token per user and refuses the old one (403). So two refreshes must never run at once,
// or the second, carrying the cookie the first just replaced, logs the user out.
//
// Within a tab, every caller (app-load restore, the 401 interceptor, the expiry scheduler, the
// sockets) shares the single in-flight request. Across tabs, the request runs inside a Web Lock
// (navigator.locks): another tab waits for the lock, and by then the browser holds the cookie the
// first tab received, so its own refresh succeeds. The tabs share the cookie, not the access token
// (it stays in each tab's memory).
export const REFRESH_LOCK = 'forexedge-auth-refresh';

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

// The browser's lock manager (absent in an insecure context or a very old browser: then only the
// in-tab single flight applies)
function lockManager(): LockManagerLike | undefined {
  return typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
}

let inFlight: Promise<SessionTokens | null> | null = null;

function requestRefresh(): Promise<SessionTokens | null> {
  return fetch(`${API_BASE.AUTH}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => (res.ok ? ((await res.json()) as SessionTokens) : null))
    .catch(() => null);
}

export function refreshSession(): Promise<SessionTokens | null> {
  const locks = lockManager();
  inFlight ??= (locks ? locks.request(REFRESH_LOCK, requestRefresh) : requestRefresh())
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// When an access token expires (ms since the epoch), read from its payload without verifying it:
// only to schedule a refresh. The servers verify every token. null if it can't be read.
export function tokenExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
