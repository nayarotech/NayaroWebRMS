import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MailQuestion } from 'lucide-react';
import type { PlatformPendingSignup } from '@nayaro/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatRelative } from '@/lib/dates';
import { platformApi } from '@/features/platform/platformApi';

const COLUMNS: readonly Column<PlatformPendingSignup>[] = [
  {
    key: 'restaurant',
    header: 'Restaurant',
    cell: (row) => (
      <div className="min-w-0">
        <p className="truncate font-bold">{row.restaurantName}</p>
        <p className="text-muted-2 truncate font-mono text-caption">{row.workspace}</p>
      </div>
    ),
    sortValue: (row) => row.restaurantName.toLowerCase(),
  },
  {
    key: 'owner',
    header: 'Owner',
    cell: (row) => (
      <div className="min-w-0">
        <p className="truncate">{row.ownerName}</p>
        <a href={`mailto:${row.email}`} className="text-accent-hover truncate text-caption hover:underline">
          {row.email}
        </a>
      </div>
    ),
  },
  {
    key: 'started',
    header: 'Started',
    cell: (row) => <span className="text-muted text-caption">{formatRelative(row.createdAt)}</span>,
    sortValue: (row) => Date.parse(row.createdAt),
  },
  {
    key: 'code',
    header: 'Code',
    cell: (row) =>
      row.expired ? (
        <Badge tone="neutral">Expired</Badge>
      ) : row.attempts >= 5 ? (
        <Badge tone="danger">Locked</Badge>
      ) : (
        <Badge tone="warning" dot>
          Waiting
        </Badge>
      ),
    sortValue: (row) => (row.expired ? 2 : row.attempts >= 5 ? 1 : 0),
  },
  {
    key: 'attempts',
    header: 'Wrong tries',
    cell: (row) => <span className="font-mono tabular-nums">{row.attempts}</span>,
    sortValue: (row) => row.attempts,
    align: 'right',
    hideBelow: 'md',
  },
];

/**
 * People who filled in the form but never entered their code: a mistyped
 * address, a spam folder, or someone who gave up. Worth a friendly email.
 */
export function PlatformSignupsScreen(): JSX.Element {
  const signups = useQuery({ queryKey: ['platform', 'signups'], queryFn: platformApi.signups, refetchInterval: 30_000 });
  return (
    <Page>
      <PageHeader
        title="Unfinished sign-ups"
        description="Started registering but never entered the emailed code. Nothing was created for them yet."
      />
      <Card>
        <DataTable
          rows={signups.data?.signups ?? []}
          columns={COLUMNS}
          getRowId={(row) => row.email}
          loading={signups.isPending}
          searchText={(row) => `${row.restaurantName} ${row.workspace} ${row.ownerName} ${row.email}`}
          searchPlaceholder="Search restaurant, owner or email…"
          initialSort={{ key: 'started', direction: 'desc' }}
          empty={{ icon: MailQuestion, title: 'No unfinished sign-ups', description: 'Everyone who started has finished.' }}
        />
      </Card>
    </Page>
  );
}
