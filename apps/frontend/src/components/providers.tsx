'use client';

import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { store } from '../store';
import { setCredentials, clearCredentials } from '../store/slices/auth.slice';
import { refreshSession } from '../lib/session';

// On app load, restore the session from the httpOnly refresh cookie.
// refreshSession() is single-flight, so StrictMode's double effect is harmless.
// Older builds persisted the access token in localStorage; remove any leftovers.
const LEGACY_STORAGE_KEYS = ['fx_access_token', 'fx_user', 'accessToken', 'user'];

function SessionRestorer() {
  useEffect(() => {
    try {
      LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch {
      // Storage unavailable (privacy mode): nothing to clean up.
    }
    if (store.getState().auth.sessionRestored) return;
    void refreshSession().then((session) => {
      if (store.getState().auth.isAuthenticated) return; // logged in meanwhile
      store.dispatch(session ? setCredentials(session) : clearCredentials());
    });
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Provider store={store}>
      <SessionRestorer />
      {children}
    </Provider>
  );
}
