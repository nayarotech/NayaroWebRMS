import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { InlineAlert } from '@/components/ui/States';
import { lastWorkspace, useAuthStore } from '@/stores/authStore';
import { homePathFor } from '@/app/navigation';
import { useAuth } from '../hooks/useAuth';
import { lookupWorkspace } from '../api/auth.api';

export function LoginForm(): JSX.Element {
  const { signIn, isSigningIn, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const notice = useAuthStore((state) => state.notice);
  const clearNotice = useAuthStore((state) => state.clearNotice);

  const [workspace, setWorkspace] = useState(() => params.get('workspace') ?? lastWorkspace());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const restaurantName = useWorkspaceName(workspace);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    clearNotice();
    if (!(await signIn(workspace, username, password))) return;
    const staff = useAuthStore.getState().staff;
    const from = (location.state as { from?: string } | null)?.from;
    await navigate(from ?? (staff === null ? '/' : homePathFor(staff)), { replace: true });
  };

  return (
    <form
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      noValidate
    >
      {notice !== null && (
        <InlineAlert tone="warning" className="mb-5">
          {notice}
        </InlineAlert>
      )}

      <TextField
        label="Workspace"
        placeholder="your-restaurant"
        hint={restaurantName === null ? 'The workspace code your restaurant registered with.' : undefined}
        autoComplete="organization"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus={workspace === ''}
        value={workspace}
        onChange={(event) => {
          setWorkspace(event.target.value);
          clearError();
        }}
        className={restaurantName === null ? undefined : 'mb-1'}
      />
      {restaurantName !== null && (
        <p className="text-ok-fg mb-4 flex items-center gap-1.5 text-caption font-bold">
          <CheckCircle2 size={14} aria-hidden />
          {restaurantName}
        </p>
      )}

      <TextField
        label="Username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus={workspace !== ''}
        value={username}
        onChange={(event) => {
          setUsername(event.target.value);
          clearError();
        }}
      />

      <TextField
        label="Password"
        secret
        autoComplete="current-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          clearError();
        }}
      />

      {error !== null && <InlineAlert className="mb-4">{error}</InlineAlert>}

      <Button
        type="submit"
        size="lg"
        loading={isSigningIn}
        disabled={workspace.trim() === '' || username.trim() === '' || password === ''}
        className="w-full"
      >
        {isSigningIn ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

/** Confirms a workspace code by name once the user pauses typing. */
function useWorkspaceName(workspace: string): string | null {
  const code = workspace.trim().toLowerCase();
  const [found, setFound] = useState<{ code: string; name: string } | null>(null);
  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(code)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      lookupWorkspace(code)
        .then((result) => {
          if (!cancelled) setFound({ code, name: result.name });
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);
  return found !== null && found.code === code ? found.name : null;
}
