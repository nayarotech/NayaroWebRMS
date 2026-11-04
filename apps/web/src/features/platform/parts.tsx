import type { JSX } from 'react';
import { Link } from 'react-router';
import type { PlatformActivityEntry, PlatformDayPoint, PlatformTenantRow } from '@nayaro/shared';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { formatRelative, formatShortDay } from '@/lib/dates';
import type { BarDatum } from '@/components/charts/BarChart';

const STATUS: Record<PlatformTenantRow['status'], { label: string; tone: BadgeTone }> = {
  TRIAL: { label: 'Trial', tone: 'accent' },
  ACTIVE: { label: 'Paying', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function TenantStatusBadge({ status }: { readonly status: PlatformTenantRow['status'] }): JSX.Element {
  const meta = STATUS[status];
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

/** "9 days left", "Ends today", "Ended 3 days ago", "No end date". */
export function TrialLeft({ row }: { readonly row: Pick<PlatformTenantRow, 'daysLeft' | 'status'> }): JSX.Element {
  if (row.daysLeft === null) return <span className="text-muted">No end date</span>;
  if (row.daysLeft < 0) {
    return <span className="text-danger-fg font-semibold">Ended {Math.abs(row.daysLeft)}d ago</span>;
  }
  if (row.daysLeft === 0) return <span className="text-warn-fg font-semibold">Ends today</span>;
  return (
    <span className={row.daysLeft <= 3 ? 'text-warn-fg font-semibold' : undefined}>
      {row.daysLeft} day{row.daysLeft === 1 ? '' : 's'} left
    </span>
  );
}

export function LastActive({ iso, online }: { readonly iso: string | null; readonly online: number }): JSX.Element {
  if (online > 0) {
    return (
      <span className="text-ok-fg inline-flex items-center gap-1.5 font-semibold">
        <span aria-hidden className="bg-ok size-2 animate-pulse rounded-full" />
        {online} online
      </span>
    );
  }
  return <span className="text-muted">{iso === null ? 'Never' : formatRelative(iso)}</span>;
}

/** Plain words for audit actions, so the feed reads like a story. */
const ACTION_LABEL: Record<string, string> = {
  AUTH_LOGIN: 'Signed in',
  AUTH_LOGIN_FAILED: 'Failed sign-in',
  AUTH_LOGOUT: 'Signed out',
  AUTH_PASSWORD_CHANGED: 'Password changed',
  TENANT_REGISTERED: 'Registered',
  STAFF_CREATED: 'Staff added',
  PLATFORM_ACCOUNT_CHANGED: 'Account changed by Nayaro',
  SUPPORT_VIEW_STARTED: 'Support view',
};

export function actionLabel(action: string): string {
  return (
    ACTION_LABEL[action] ??
    action
      .toLowerCase()
      .split('_')
      .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ')
  );
}

function actionTone(action: string): BadgeTone {
  if (action.includes('FAILED')) return 'danger';
  if (action === 'TENANT_REGISTERED') return 'success';
  if (action.startsWith('PLATFORM') || action.startsWith('SUPPORT')) return 'warning';
  if (action.startsWith('AUTH')) return 'neutral';
  return 'accent';
}

export function ActivityRow({
  entry,
  showRestaurant = true,
}: {
  readonly entry: PlatformActivityEntry;
  readonly showRestaurant?: boolean;
}): JSX.Element {
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <Badge tone={actionTone(entry.action)} className="mt-0.5 shrink-0">
        {actionLabel(entry.action)}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-body">
          {showRestaurant && (
            <Link to={`/admin/restaurants/${entry.restaurant.id}`} className="font-bold hover:underline">
              {entry.restaurant.name}
            </Link>
          )}
          {showRestaurant && <span className="text-muted-3"> · </span>}
          <span className="text-text-2">{entry.summary}</span>
        </p>
        <p className="text-muted-2 text-caption">
          {formatRelative(entry.createdAt)}
          {entry.staffName !== null && ` · ${entry.staffName}`}
          {entry.ipAddress !== null && ` · ${entry.ipAddress}`}
        </p>
      </div>
    </li>
  );
}

/** A 30-day series as chart bars, labelling every fifth day and today. */
export function toBars(
  points: readonly PlatformDayPoint[],
  describe: (value: number) => string,
): BarDatum[] {
  return points.map((point, index) => ({
    key: point.date,
    label: formatShortDay(point.date),
    value: point.value,
    title: formatShortDay(point.date),
    detail: describe(point.value),
    highlight: index === points.length - 1,
  }));
}
