import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { AuthenticatedStaff } from '@nayaro/shared';
import { Lock } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/services/apiClient';
import { fetchCurrentSession } from '@/features/auth/api/auth.api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/States';
import { Page } from '@/components/layout/Page';
import { homePathFor } from './navigation';

/**
 * Route boundaries. These decide what to RENDER; they are not security. Every
 * request is authorised again by the API, so a guard that is bypassed only
 * shows an empty screen that the server refuses to fill.
 */

function Splash({ message, action }: { message: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="bg-base grid h-dvh place-items-center px-6">
      <div className="text-center">
        <div className="bg-accent mx-auto grid size-12 place-items-center rounded-card text-xl font-extrabold text-white">
          N
        </div>
        <p className="text-muted mt-4 text-body font-semibold">{message}</p>
        {action !== undefined && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

/**
 * A stored token is only a claim. Before showing anything that depends on who
 * is signed in, ask the server to confirm it and to say who it belongs to.
 */
function useVerifySession(): { failed: boolean; retry: () => void } {
  const status = useAuthStore((state) => state.status);
  const token = useAuthStore((state) => state.token);
  const confirmSession = useAuthStore((state) => state.confirmSession);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status !== 'verifying' || token === null) return;
    let cancelled = false;
    fetchCurrentSession()
      .then((session) => {
        if (!cancelled) confirmSession(session.staff, session.tenant);
      })
      .catch((error: unknown) => {
        // A rejected token is handled by the API client, which signs out.
        // Anything else (offline, server down) keeps the token for a retry.
        if (!cancelled && !(error instanceof ApiRequestError && error.status === 401)) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [status, token, confirmSession, attempt]);

  return {
    failed,
    retry: () => {
      setFailed(false);
      setAttempt((value) => value + 1);
    },
  };
}

/** /login and /register: signed-in visitors go straight into the app. */
export function PublicRoute(): JSX.Element {
  const status = useAuthStore((state) => state.status);
  const staff = useAuthStore((state) => state.staff);
  const { failed, retry } = useVerifySession();

  if (status === 'verifying') {
    return failed ? (
      <Splash
        message="Cannot reach Nayaro RMS right now."
        action={
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        }
      />
    ) : (
      <Splash message="Checking your session…" />
    );
  }
  if (status === 'authenticated' && staff !== null) return <Navigate to={homePathFor(staff)} replace />;
  return <Outlet />;
}

export function AuthenticatedRoute(): JSX.Element {
  const status = useAuthStore((state) => state.status);
  const location = useLocation();
  const { failed, retry } = useVerifySession();

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (status === 'verifying') {
    return failed ? (
      <Splash
        message="Cannot reach Nayaro RMS right now."
        action={
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        }
      />
    ) : (
      <Splash message="Opening your restaurant…" />
    );
  }
  return <Outlet />;
}

/** Hides a screen from roles that cannot use it, inside the normal shell. */
export function RoleRoute({
  allow,
  children,
}: {
  allow: (staff: AuthenticatedStaff) => boolean;
  children: ReactNode;
}): JSX.Element {
  const staff = useAuthStore((state) => state.staff);
  if (staff !== null && !allow(staff)) {
    return (
      <Page>
        <EmptyState
          icon={Lock}
          title="Not available for your role"
          description="Ask an owner or manager if you need access to this screen."
        />
      </Page>
    );
  }
  return <>{children}</>;
}

/** `/` sends each role to the screen it starts its shift on. */
export function HomeRedirect(): JSX.Element {
  const staff = useAuthStore((state) => state.staff);
  return <Navigate to={staff === null ? '/login' : homePathFor(staff)} replace />;
}
