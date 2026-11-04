import { useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import type { PlatformTenantRow } from '@nayaro/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Segmented } from '@/components/ui/Tabs';
import { ErrorState } from '@/components/ui/States';
import { formatPaisa } from '@/lib/money';
import { formatRelative } from '@/lib/dates';
import { platformApi } from '@/features/platform/platformApi';
import { LastActive, TenantStatusBadge, TrialLeft } from '@/features/platform/parts';

type Filter = 'all' | 'TRIAL' | 'ending' | 'ACTIVE' | 'SUSPENDED' | 'online';

const COLUMNS: readonly Column<PlatformTenantRow>[] = [
  {
    key: 'name',
    header: 'Restaurant',
    cell: (row) => (
      <div className="min-w-0">
        <p className="truncate font-bold">{row.name}</p>
        <p className="text-muted-2 truncate font-mono text-caption">{row.workspace}</p>
      </div>
    ),
    sortValue: (row) => row.name.toLowerCase(),
  },
  {
    key: 'owner',
    header: 'Owner',
    cell: (row) => (
      <div className="min-w-0">
        <p className="truncate">{row.owner?.name ?? '—'}</p>
        <p className="text-muted-2 truncate text-caption">{row.owner?.email ?? row.contactEmail ?? row.phone}</p>
      </div>
    ),
    hideBelow: 'md',
  },
  { key: 'status', header: 'Status', cell: (row) => <TenantStatusBadge status={row.status} />, sortValue: (row) => row.status },
  {
    key: 'ends',
    header: 'Trial / plan',
    cell: (row) => (
      <span className="text-caption">
        <TrialLeft row={row} />
      </span>
    ),
    sortValue: (row) => row.daysLeft ?? 99_999,
    hideBelow: 'sm',
  },
  {
    key: 'active',
    header: 'Last active',
    cell: (row) => (
      <span className="text-caption">
        <LastActive iso={row.lastActiveAt} online={row.onlineNow} />
      </span>
    ),
    sortValue: (row) => (row.onlineNow > 0 ? Number.MAX_SAFE_INTEGER : Date.parse(row.lastActiveAt ?? '1970-01-01')),
    hideBelow: 'md',
  },
  {
    key: 'bills',
    header: 'Bills 30d',
    cell: (row) => <span className="font-mono tabular-nums">{row.bills30d}</span>,
    sortValue: (row) => row.bills30d,
    align: 'right',
    hideBelow: 'lg',
  },
  {
    key: 'sales',
    header: 'Sales 30d',
    cell: (row) => <span className="font-mono tabular-nums">{formatPaisa(row.sales30dPaisa)}</span>,
    sortValue: (row) => row.sales30dPaisa,
    align: 'right',
    hideBelow: 'lg',
  },
  {
    key: 'joined',
    header: 'Joined',
    cell: (row) => <span className="text-muted text-caption">{formatRelative(row.createdAt)}</span>,
    sortValue: (row) => Date.parse(row.createdAt),
    hideBelow: 'lg',
  },
];

export function PlatformTenantsScreen(): JSX.Element {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const tenants = useQuery({ queryKey: ['platform', 'tenants'], queryFn: platformApi.tenants, refetchInterval: 30_000 });

  const rows = useMemo(() => {
    const all = tenants.data?.tenants ?? [];
    if (filter === 'all') return all;
    if (filter === 'ending') {
      return all.filter((row) => row.status === 'TRIAL' && row.daysLeft !== null && row.daysLeft <= 7);
    }
    if (filter === 'online') return all.filter((row) => row.onlineNow > 0);
    return all.filter((row) => row.status === filter);
  }, [tenants.data, filter]);

  return (
    <Page>
      <PageHeader
        title="Restaurants"
        description="Everyone who has registered, their trial, and how much they use Nayaro RMS."
      />
      {tenants.isError && tenants.data === undefined ? (
        <Card>
          <ErrorState error={tenants.error} onRetry={() => void tenants.refetch()} />
        </Card>
      ) : (
        <Card>
          <DataTable
            rows={rows}
            columns={COLUMNS}
            getRowId={(row) => row.id}
            loading={tenants.isPending}
            searchText={(row) =>
              `${row.name} ${row.workspace} ${row.owner?.name ?? ''} ${row.owner?.email ?? ''} ${row.contactEmail ?? ''} ${row.phone}`
            }
            searchPlaceholder="Search name, workspace, owner, email or phone…"
            toolbar={
              <Segmented
                label="Filter"
                value={filter}
                onChange={setFilter}
                items={[
                  { value: 'all', label: 'All' },
                  { value: 'TRIAL', label: 'Trial' },
                  { value: 'ending', label: 'Ending ≤7d' },
                  { value: 'ACTIVE', label: 'Paying' },
                  { value: 'SUSPENDED', label: 'Suspended' },
                  { value: 'online', label: 'Online' },
                ]}
              />
            }
            initialSort={{ key: 'joined', direction: 'desc' }}
            pageSize={25}
            onRowClick={(row) => void navigate(`/admin/restaurants/${row.id}`)}
            empty={{ icon: Store, title: 'No restaurants match' }}
          />
        </Card>
      )}
    </Page>
  );
}
