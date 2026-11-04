import type { JSX } from 'react';
import { Eye } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { formatTime } from '@/lib/dates';

/**
 * Shown on every screen while Nayaro support is viewing a restaurant through
 * the console. The server refuses every change in this mode; the banner makes
 * sure nobody is left wondering why a button did nothing.
 */
export function SupportViewBanner(): JSX.Element | null {
  const view = useAuthStore((state) => state.impersonation);
  const tenant = useAuthStore((state) => state.tenant);
  const { signOut } = useAuth();
  if (view === null) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-warn px-4 py-2 text-caption font-bold text-white"
    >
      <Eye size={15} aria-hidden />
      <span className="min-w-0 flex-1">
        Read-only support view of {tenant?.name ?? 'this restaurant'} by {view.adminName}. Nothing can be changed. Ends{' '}
        {formatTime(view.expiresAt)}.
      </span>
      <button
        type="button"
        onClick={() => {
          void signOut().then(() => {
            window.location.assign('/admin');
          });
        }}
        className="rounded-md bg-white/20 px-3 py-1 text-white hover:bg-white/30"
      >
        End support view
      </button>
    </div>
  );
}
