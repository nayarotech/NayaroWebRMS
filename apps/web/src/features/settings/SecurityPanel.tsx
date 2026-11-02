import type { JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone, ScrollText } from 'lucide-react';
import type { AuditLogResponse, StaffRole } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { ErrorState } from '@/components/ui/States';
import { AUDIT_KEY, SESSIONS_KEY, managementApi } from '@/features/management/hooks/useManagement';
import { formatDateTime, formatRelative } from '@/lib/dates';

interface SessionRow {
  readonly id: string;
  readonly deviceLabel: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly staff: { readonly name: string; readonly username: string; readonly role: StaffRole };
}

/** Devices currently signed in to this restaurant, with remote sign-out. */
export function SessionsPanel(): JSX.Element {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => apiClient.get<{ sessions: SessionRow[] }>('/auth/sessions'),
    refetchInterval: 60_000,
  });

  return (
    <div>
      <CardHeader
        className="px-0 pt-0"
        title="Signed-in devices"
        description="Sign out a lost or shared device. It must sign in again with a password."
      />
      {sessions.isError ? (
        <Card>
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
        </Card>
      ) : (
        <DataTable
          rows={sessions.data?.sessions ?? []}
          loading={sessions.isPending}
          getRowId={(row) => row.id}
          searchText={(row) => `${row.staff.name} ${row.staff.username} ${row.deviceLabel ?? ''}`}
          searchPlaceholder="Search people or devices"
          empty={{ icon: MonitorSmartphone, title: 'No active sessions' }}
          columns={[
            {
              key: 'staff',
              header: 'Person',
              sortValue: (row) => row.staff.name,
              cell: (row) => (
                <div>
                  <p className="font-bold">{row.staff.name}</p>
                  <p className="text-muted text-caption">{row.staff.username}</p>
                </div>
              ),
            },
            { key: 'role', header: 'Role', cell: (row) => <Badge>{row.staff.role.toLowerCase()}</Badge>, hideBelow: 'sm' },
            {
              key: 'device',
              header: 'Device',
              hideBelow: 'md',
              cell: (row) => (
                <div>
                  <p>{row.deviceLabel ?? 'Unknown device'}</p>
                  {row.ipAddress !== null && <p className="text-muted font-mono text-caption">{row.ipAddress}</p>}
                </div>
              ),
            },
            {
              key: 'seen',
              header: 'Last active',
              sortValue: (row) => row.lastSeenAt,
              cell: (row) => <span title={formatDateTime(row.lastSeenAt)}>{formatRelative(row.lastSeenAt)}</span>,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              cell: (row) => (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={LogOut}
                  onClick={() => {
                    void managementApi.revokeSession(row.id).then(() =>
                      queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
                    );
                  }}
                >
                  Sign out
                </Button>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

const ACTION_LABELS: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  AUTH_LOGIN: { label: 'Sign-in', tone: 'neutral' },
  AUTH_LOGIN_FAILED: { label: 'Failed sign-in', tone: 'warning' },
  AUTH_LOGOUT: { label: 'Sign-out', tone: 'neutral' },
  AUTH_PASSWORD_CHANGED: { label: 'Password', tone: 'accent' },
  TENANT_REGISTERED: { label: 'Registered', tone: 'success' },
  STAFF_CREATED: { label: 'Staff', tone: 'accent' },
  STAFF_UPDATED: { label: 'Staff', tone: 'accent' },
  STAFF_PASSWORD_RESET: { label: 'Password reset', tone: 'warning' },
  SETTINGS_RESTAURANT_UPDATED: { label: 'Settings', tone: 'accent' },
  SETTINGS_FINANCIAL_UPDATED: { label: 'Tax settings', tone: 'warning' },
  SETTINGS_OPERATIONAL_UPDATED: { label: 'Settings', tone: 'accent' },
  INVOICE_VOIDED: { label: 'Invoice void', tone: 'danger' },
  ORDER_VOIDED: { label: 'Payment void', tone: 'danger' },
  PAYMENT_REFUNDED: { label: 'Refund', tone: 'danger' },
  DATA_EXPORTED: { label: 'Export', tone: 'neutral' },
};

/** Owner-only record of sign-ins and sensitive changes. */
export function AuditLogPanel(): JSX.Element {
  const log = useQuery({
    queryKey: AUDIT_KEY,
    queryFn: () => apiClient.get<AuditLogResponse>('/audit-log?limit=100'),
  });

  return (
    <div>
      <CardHeader
        className="px-0 pt-0"
        title="Activity log"
        description="Sign-ins, account changes, tax settings, voids and refunds. Kept permanently."
      />
      {log.isError ? (
        <Card>
          <ErrorState
            error={log.error}
            forbiddenMessage="Only an owner can see the activity log."
            onRetry={() => void log.refetch()}
          />
        </Card>
      ) : (
        <DataTable
          rows={log.data?.entries ?? []}
          loading={log.isPending}
          getRowId={(row) => row.id}
          searchText={(row) => `${row.summary} ${row.staff?.name ?? ''} ${row.action}`}
          searchPlaceholder="Search activity"
          pageSize={12}
          empty={{ icon: ScrollText, title: 'No activity yet' }}
          columns={[
            {
              key: 'when',
              header: 'When',
              sortValue: (row) => row.createdAt,
              cell: (row) => (
                <span className="whitespace-nowrap" title={formatDateTime(row.createdAt)}>
                  {formatRelative(row.createdAt)}
                </span>
              ),
            },
            {
              key: 'action',
              header: 'Type',
              cell: (row) => {
                const meta = ACTION_LABELS[row.action] ?? { label: row.action, tone: 'neutral' as const };
                return <Badge tone={meta.tone}>{meta.label}</Badge>;
              },
            },
            { key: 'summary', header: 'Details', cell: (row) => row.summary },
            {
              key: 'who',
              header: 'By',
              hideBelow: 'md',
              cell: (row) => row.staff?.name ?? <span className="text-muted">—</span>,
            },
          ]}
        />
      )}
    </div>
  );
}
