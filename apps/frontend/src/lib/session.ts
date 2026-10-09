import { API_BASE } from './constants';
import type { AuthUser } from '../types/api.types';

export interface SessionTokens {
  accessToken: string;
  user: AuthUser;
}

// The refresh token is an httpOnly cookie and is rotated on every use, so two
// concurrent refresh calls would invalidate each other. Every caller (app-load
// restore, 401 interceptor) shares the single in-flight request.
let inFlight: Promise<SessionTokens | null> | null = null;

export function refreshSession(): Promise<SessionTokens | null> {
  inFlight ??= fetch(`${API_BASE.AUTH}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => (res.ok ? ((await res.json()) as SessionTokens) : null))
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
