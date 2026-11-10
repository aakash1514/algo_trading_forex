import type { AppDispatch } from '../store';
import { sessionExpired, setCredentials } from '../store/slices/auth.slice';
import { refreshSession } from './session';

// Socket events for access-token expiry, as in libs/common/src/lib/socket-auth.ts: the server emits
// AUTH_EXPIRED_EVENT and closes the socket when the token it connected with expires; replay-service
// also takes REAUTH_EVENT with a refreshed token, which keeps the socket open.
export const AUTH_EXPIRED_EVENT = 'authExpired';
export const REAUTH_EVENT = 'reauth';

// After the server dropped or refused a socket for its token: one refresh through the app's shared
// single flight. true: a fresh token is in the store, connect again. false: the session is over
// (sessionExpired: the login page says so); the caller stops and never retries by itself.
export async function renewSessionForSocket(dispatch: AppDispatch): Promise<boolean> {
  const session = await refreshSession();
  if (!session) {
    dispatch(sessionExpired());
    return false;
  }
  dispatch(setCredentials(session));
  return true;
}
