'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAppSelector } from '../../store';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-terminal-bg flex items-center justify-center">
        <div className="flex items-center gap-2 text-terminal-muted text-sm">
          <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
          Redirecting...
        </div>
      </div>
    );
  }

  return <>{children}</>;
}