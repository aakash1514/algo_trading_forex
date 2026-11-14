'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useGetAuthConfigQuery } from '../../store/api/auth.api';
import { RegisterForm } from './RegisterForm';

export const REGISTRATION_CLOSED_TEXT = 'Registration is closed on this deployment.';

// The sign-up form only when auth-service says registration is open. The setting is asked at runtime
// (GET /api/auth/config), not baked into the build, so one frontend image serves an open dev setup
// and a closed production. While unknown or on an error, no form is shown: the API refuses a closed
// sign-up anyway (403), this only avoids offering a form that can't work. Once it is known to be closed,
// the page moves to /login (replace: Back doesn't return here), where the demo-access card says how to
// get a login; the text below shows only for that moment, or when the config couldn't be loaded.
export function RegisterGate() {
  const router = useRouter();
  const { data, isLoading } = useGetAuthConfigQuery();
  const closed = data?.registrationEnabled === false;

  useEffect(() => {
    if (closed) router.replace('/login');
  }, [closed, router]);

  if (data?.registrationEnabled === true) return <RegisterForm />;

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-8">
      <h1 className="text-lg font-medium text-[#e2e4e9] mb-1">Create account</h1>
      <p role="status" className="text-sm text-terminal-muted mb-6">
        {isLoading ? 'Checking…' : REGISTRATION_CLOSED_TEXT}
      </p>
      <Link href="/login" className="text-[12px] text-accent-blue hover:text-accent-blue/80 transition-colors">
        Back to sign in
      </Link>
    </div>
  );
}
