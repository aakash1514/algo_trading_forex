'use client';

import { useEffect, useRef } from 'react';
import { Provider } from 'react-redux';
import { store } from '../store';
import { setCredentials } from '../store/slices/auth.slice';

function AuthRehydrator() {
  const rehydrated = useRef(false);

  useEffect(() => {
    if (rehydrated.current) return;
    rehydrated.current = true;

    try {
      const token = localStorage.getItem('accessToken');
      const user = localStorage.getItem('user');
      if (token && user) {
        store.dispatch(setCredentials({
          accessToken: token,
          user: JSON.parse(user),
        }));
      }
    } catch {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
    }
  }, []);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Provider store={store}>
      <AuthRehydrator />
      {children}
    </Provider>
  );
}