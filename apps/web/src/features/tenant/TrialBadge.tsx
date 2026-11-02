import type { JSX } from 'react';
import { Clock } from 'lucide-react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useNow } from '@/features/kitchen/hooks/useKitchen';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trial restaurants see how long they have left, so expiry is never a surprise. */
export function TrialBadge(): JSX.Element | null {
  const { tenant } = useAuth();
  const now = useNow(60 * 60 * 1000);
  if (tenant === null || tenant.status !== 'TRIAL' || tenant.subscriptionEndsAt === null) return null;
  const days = Math.max(0, Math.ceil((Date.parse(tenant.subscriptionEndsAt) - now) / DAY_MS));
  return (
    <span
      title={`Trial ends ${new Date(tenant.subscriptionEndsAt).toLocaleDateString()}`}
      className="bg-accent-soft text-accent-hover hidden items-center gap-1.5 rounded-control px-2.5 py-1.5 text-caption font-bold md:flex"
    >
      <Clock size={14} aria-hidden />
      Trial · {days === 0 ? 'ends today' : `${String(days)} day${days === 1 ? '' : 's'} left`}
    </span>
  );
}
