import type { JSX } from 'react';
import { Link } from 'react-router';
import { LoginForm } from '@/features/auth/components/LoginForm';
import { AuthLayout } from '@/components/layout/AuthLayout';

export function LoginScreen(): JSX.Element {
  return (
    <AuthLayout>
      <h1 className="text-display font-extrabold tracking-tight">Sign in</h1>
      <p className="text-muted mt-1 mb-8 text-body">Start your shift at your restaurant.</p>
      <LoginForm />
      <p className="text-muted mt-8 text-center text-body">
        New to Nayaro RMS?{' '}
        <Link to="/register" className="text-accent-hover font-bold hover:underline">
          Register your restaurant
        </Link>
      </p>
    </AuthLayout>
  );
}
