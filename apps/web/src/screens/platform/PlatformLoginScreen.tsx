import { useState, type FormEvent, type JSX } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import { NayaroLogo } from '@/components/layout/NayaroBrand';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { InlineAlert } from '@/components/ui/States';
import { ApiRequestError } from '@/services/apiClient';
import { platformApi, usePlatformStore } from '@/features/platform/platformApi';

/** Sign-in for Nayaro Technology staff. Restaurant accounts cannot use it. */
export function PlatformLoginScreen(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, setSession } = usePlatformStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token !== null) return <Navigate to="/admin" replace />;

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await platformApi.login(email.trim(), password);
      setSession(result.token, result.admin);
      const from = (location.state as { from?: string } | null)?.from;
      await navigate(from?.startsWith('/admin') === true ? from : '/admin', { replace: true });
    } catch (cause: unknown) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-[#0a0e17] px-4">
      <div aria-hidden className="ny-diagonal-dark absolute inset-0" />
      <div className="bg-surface relative w-full max-w-sm rounded-panel p-7 shadow-overlay">
        <div className="flex items-center gap-2">
          <NayaroLogo tone="light" className="h-auto w-[120px] dark:hidden" />
          <NayaroLogo className="hidden h-auto w-[120px] dark:block" />
          <span className="border-accent/40 bg-accent-soft text-accent rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-widest">
            ADMIN
          </span>
        </div>
        <h1 className="mt-6 text-title font-extrabold tracking-tight">Nayaro console</h1>
        <p className="text-muted mt-1 mb-6 flex items-center gap-1.5 text-caption">
          <ShieldCheck size={14} aria-hidden />
          For Nayaro Technology staff only.
        </p>
        <form
          noValidate
          onSubmit={(event) => {
            void onSubmit(event);
          }}
        >
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
          />
          <TextField
            label="Password"
            secret
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
            }}
          />
          {error !== null && <InlineAlert className="mb-4">{error}</InlineAlert>}
          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={email === '' || password === ''}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
