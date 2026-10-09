'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAppSelector } from '../../store';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, sessionRestored } = useAppSelector((s) => s.auth);

  useEffect(() => {
    // Wait for the app-load session restore before deciding.
    if (sessionRestored && !isAuthenticated) {
      router.replace('/login');
    }
  }, [sessionRestored, isAuthenticated, router]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-terminal-bg flex items-center justify-center">
        <div className="flex items-center gap-2 text-terminal-muted text-sm">
          <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
          {sessionRestored ? 'Redirecting...' : 'Restoring session...'}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
