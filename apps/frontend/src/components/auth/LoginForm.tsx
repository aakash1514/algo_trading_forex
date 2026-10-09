'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useLoginMutation } from '../../store/api/auth.api';
import { useAppDispatch, useAppSelector } from '../../store';
import { setCredentials } from '../../store/slices/auth.slice';
import { cn } from '../../lib/cn';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [login, { isLoading }] = useLoginMutation();
  const [serverError, setServerError] = useState<string | null>(null);
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);

  // A session restored from the refresh cookie skips the login form.
  useEffect(() => {
    if (isAuthenticated) router.replace('/dashboard');
  }, [isAuthenticated, router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  async function onSubmit(data: LoginFormData) {
    setServerError(null);
    try {
      const result = await login(data).unwrap();
      dispatch(setCredentials({ user: result.user, accessToken: result.accessToken }));
      router.push('/dashboard');
    } catch (err: any) {
      setServerError(err?.data?.message ?? 'Invalid email or password');
    }
  }

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-8">
      <h1 className="text-lg font-medium text-[#e2e4e9] mb-1">Sign in</h1>
      <p className="text-sm text-terminal-muted mb-6">
        Access your trading terminal
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
            Email
          </label>
          <input
            {...register('email')}
            type="email"
            autoComplete="email"
            placeholder="trader@example.com"
            className={cn(
              'w-full bg-terminal-elevated border rounded-md px-3 py-2.5 text-sm text-[#e2e4e9]',
              'placeholder:text-terminal-muted/50',
              'focus:outline-none focus:border-accent-blue',
              'transition-colors duration-150',
              errors.email ? 'border-accent-red' : 'border-terminal-border'
            )}
          />
          {errors.email && (
            <p className="mt-1 text-[11px] text-accent-red">{errors.email.message}</p>
          )}
        </div>

        <div>
          <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
            Password
          </label>
          <input
            {...register('password')}
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            className={cn(
              'w-full bg-terminal-elevated border rounded-md px-3 py-2.5 text-sm text-[#e2e4e9]',
              'placeholder:text-terminal-muted/50',
              'focus:outline-none focus:border-accent-blue',
              'transition-colors duration-150',
              errors.password ? 'border-accent-red' : 'border-terminal-border'
            )}
          />
          {errors.password && (
            <p className="mt-1 text-[11px] text-accent-red">{errors.password.message}</p>
          )}
        </div>

        {serverError && (
          <div className="bg-accent-red/10 border border-accent-red/30 rounded-md px-3 py-2.5">
            <p className="text-[12px] text-accent-red">{serverError}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className={cn(
            'w-full py-2.5 rounded-md text-sm font-medium',
            'bg-accent-blue/10 border border-accent-blue/40 text-accent-blue',
            'hover:bg-accent-blue/20 hover:border-accent-blue',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'transition-all duration-150'
          )}
        >
          {isLoading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-[12px] text-terminal-muted">
        No account?{' '}
        <Link
          href="/register"
          className="text-accent-blue hover:text-accent-blue/80 transition-colors"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}