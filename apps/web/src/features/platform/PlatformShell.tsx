import { useEffect, useState, type JSX } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { Activity, BarChart3, LayoutDashboard, LogOut, MailQuestion, Store, type LucideIcon } from 'lucide-react';
import { NayaroLogo } from '@/components/layout/NayaroBrand';
import { EmptyState, LoadingState } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { platformApi, usePlatformStore } from './platformApi';

const NAV: readonly { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/website', label: 'Website', icon: BarChart3 },
  { to: '/admin/restaurants', label: 'Restaurants', icon: Store },
  { to: '/admin/signups', label: 'Unfinished sign-ups', icon: MailQuestion },
  { to: '/admin/activity', label: 'Activity', icon: Activity },
];

/**
 * The Nayaro console frame. Confirms the stored console token with the server
 * before showing anything, exactly like the restaurant app does with its own.
 */
export function PlatformShell(): JSX.Element {
  const { token, admin, setAdmin, clear } = usePlatformStore();
  const location = useLocation();
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Loading is derived from the data (a token but no admin yet), never kept in
  // a separate flag: a flag cleared in `finally` can be skipped when this
  // effect re-runs, leaving the console stuck on its loading screen.
  useEffect(() => {
    if (token === null || admin !== null) return;
    let cancelled = false;
    platformApi
      .me()
      .then((result) => {
        if (!cancelled) setAdmin(result.admin);
      })
      .catch(() => {
        // A rejected token is cleared by the client (back to sign-in); any
        // other failure leaves it in place for a retry.
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, admin, setAdmin, attempt]);

  if (token === null) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  if (admin === null) {
    return unreachable ? (
      <EmptyState
        className="h-dvh justify-center"
        title="Cannot reach the Nayaro console"
        description="Check your connection and try again."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setUnreachable(false);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        }
      />
    ) : (
      <LoadingState label="Opening the Nayaro console…" className="h-dvh" />
    );
  }

  return (
    <div className="bg-base flex h-dvh overflow-hidden">
      <nav aria-label="Console" className="bg-sidebar border-border hidden w-sidebar shrink-0 flex-col border-r lg:flex">
        <div className="flex h-topbar items-center gap-2 px-5">
          <NayaroLogo tone="light" className="h-auto w-[124px] dark:hidden" />
          <NayaroLogo className="hidden h-auto w-[124px] dark:block" />
          <span className="border-accent/40 bg-accent-soft text-accent rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-widest">
            ADMIN
          </span>
        </div>
        <ul className="flex-1 space-y-0.5 px-3 py-4">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end === true}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-control border-l-[3px] px-3 py-2 text-body font-semibold transition-colors',
                    isActive
                      ? 'border-accent bg-accent-soft text-text'
                      : 'text-text-3 hover:bg-neutral-tint hover:text-text border-transparent',
                  )
                }
              >
                <Icon size={18} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="border-border border-t p-4">
          <div className="flex items-center gap-3">
            <span className="bg-accent grid size-9 place-items-center rounded-full text-body font-bold text-white">
              {admin.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-body font-bold">{admin.name}</p>
              <p className="text-muted truncate text-caption">{admin.email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void platformApi.logout().finally(clear);
            }}
            className="border-border-2 text-text-2 hover:bg-surface mt-3 flex w-full items-center justify-center gap-2 rounded-control border px-3 py-2 text-caption font-bold"
          >
            <LogOut size={15} aria-hidden />
            Sign out
          </button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {/* Small screens: the same sections as a strip of links. */}
        <div className="border-border bg-surface flex gap-1 overflow-x-auto border-b px-3 py-2 lg:hidden">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end === true}
              className={({ isActive }) =>
                cn(
                  'rounded-control px-3 py-1.5 text-caption font-bold whitespace-nowrap',
                  isActive ? 'bg-accent-soft text-accent-hover' : 'text-muted',
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </div>
        <Outlet />
      </main>
    </div>
  );
}
