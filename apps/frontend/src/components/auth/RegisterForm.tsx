'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRegisterMutation } from '../../store/api/auth.api';
import { useAppDispatch } from '../../store';
import { setCredentials } from '../../store/slices/auth.slice';
import { cn } from '../../lib/cn';

const registerSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName:  z.string().min(1, 'Last name is required'),
  email:     z.string().email('Enter a valid email'),
  username:  z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username cannot exceed 20 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers and underscores only'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .max(32, 'Password cannot exceed 32 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Must contain uppercase, lowercase, number and special character (@$!%*?&)'
    ),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

type RegisterFormData = z.infer<typeof registerSchema>;

const inputClass = (hasError: boolean) => cn(
  'w-full bg-terminal-elevated border rounded-md px-3 py-2.5 text-sm text-[#e2e4e9]',
  'placeholder:text-terminal-muted/50 focus:outline-none focus:border-accent-blue transition-colors duration-150',
  hasError ? 'border-accent-red' : 'border-terminal-border'
);

export function RegisterForm() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [register, { isLoading }] = useRegisterMutation();
  const [serverError, setServerError] = useState<string | null>(null);

  const { register: field, handleSubmit, formState: { errors } } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
  });

  async function onSubmit(data: RegisterFormData) {
    setServerError(null);
    try {
      const result = await register({
        email:     data.email,
        username:  data.username,
        password:  data.password,
        firstName: data.firstName,
        lastName:  data.lastName,
      }).unwrap();
      dispatch(setCredentials({ user: result.user, accessToken: result.accessToken }));
      router.push('/dashboard');
    } catch (err: any) {
      const msg = err?.data?.message;
      setServerError(Array.isArray(msg) ? msg[0] : (msg ?? 'Registration failed'));
    }
  }

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-8">
      <h1 className="text-lg font-medium text-[#e2e4e9] mb-1">Create account</h1>
      <p className="text-sm text-terminal-muted mb-6">Start paper trading in seconds</p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">

        {/* First + Last name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
              First name
            </label>
            <input {...field('firstName')} type="text" placeholder="Aakash"
              className={inputClass(!!errors.firstName)} />
            {errors.firstName && <p className="mt-1 text-[11px] text-accent-red">{errors.firstName.message}</p>}
          </div>
          <div>
            <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
              Last name
            </label>
            <input {...field('lastName')} type="text" placeholder="Devkar"
              className={inputClass(!!errors.lastName)} />
            {errors.lastName && <p className="mt-1 text-[11px] text-accent-red">{errors.lastName.message}</p>}
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
            Email
          </label>
          <input {...field('email')} type="email" autoComplete="email" placeholder="trader@example.com"
            className={inputClass(!!errors.email)} />
          {errors.email && <p className="mt-1 text-[11px] text-accent-red">{errors.email.message}</p>}
        </div>

        <div>
          <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
            Username
          </label>
          <input {...field('username')} type="text" autoComplete="username" placeholder="aakash_trades"
            className={inputClass(!!errors.username)} />
          {errors.username && <p className="mt-1 text-[11px] text-accent-red">{errors.username.message}</p>}
        </div>

        <div>
          <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
            Password
          </label>
          <input {...field('password')} type="password" autoComplete="new-password" placeholder="••••••••"
            className={inputClass(!!errors.password)} />
          {errors.password && <p className="mt-1 text-[11px] text-accent-red">{errors.password.message}</p>}
          <p className="mt-1 text-[10px] text-terminal-muted">
            Min 8 chars · uppercase · lowercase · number · special (@$!%*?&)
          </p>
        </div>

        <div>
          <label className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1.5">
            Confirm password
          </label>
          <input {...field('confirmPassword')} type="password" autoComplete="new-password" placeholder="••••••••"
            className={inputClass(!!errors.confirmPassword)} />
          {errors.confirmPassword && <p className="mt-1 text-[11px] text-accent-red">{errors.confirmPassword.message}</p>}
        </div>

        {serverError && (
          <div className="bg-accent-red/10 border border-accent-red/30 rounded-md px-3 py-2.5">
            <p className="text-[12px] text-accent-red">{serverError}</p>
          </div>
        )}

        <button type="submit" disabled={isLoading}
          className={cn(
            'w-full py-2.5 rounded-md text-sm font-medium',
            'bg-accent-blue/10 border border-accent-blue/40 text-accent-blue',
            'hover:bg-accent-blue/20 hover:border-accent-blue',
            'disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150'
          )}>
          {isLoading ? 'Creating account...' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-[12px] text-terminal-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-accent-blue hover:text-accent-blue/80 transition-colors">
          Sign in
        </Link>
      </p>
    </div>
  );
}