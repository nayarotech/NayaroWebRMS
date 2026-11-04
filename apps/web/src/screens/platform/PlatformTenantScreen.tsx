import { useState, type JSX } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  BookOpen,
  CalendarPlus,
  CheckCircle2,
  Eye,
  Grid3x3,
  Laptop,
  Mail,
  Phone,
  ReceiptText,
  RotateCcw,
  ShoppingBag,
  UsersRound,
  Wallet,
} from 'lucide-react';
import type { PlatformTenantAction } from '@nayaro/shared';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { StatCard } from '@/components/ui/StatCard';
import { Segmented } from '@/components/ui/Tabs';
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '@/components/ui/States';
import { BarChart } from '@/components/charts/BarChart';
import { ApiRequestError } from '@/services/apiClient';
import { formatCompactPaisa, formatPaisa, formatRupees } from '@/lib/money';
import { formatDateTime, formatRelative } from '@/lib/dates';
import { storeSupportViewToken } from '@/stores/authStore';
import { platformApi } from '@/features/platform/platformApi';
import {
  ActivityRow,
  LastActive,
  TenantStatusBadge,
  TrialLeft,
  toBars,
} from '@/features/platform/parts';

type Dialog = 'activate' | 'suspend' | null;

export function PlatformTenantScreen(): JSX.Element {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [chart, setChart] = useState<'sales' | 'bills'>('sales');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const detail = useQuery({
    queryKey: ['platform', 'tenant', id],
    queryFn: () => platformApi.tenant(id),
    refetchInterval: 30_000,
  });

  const act = useMutation({
    mutationFn: (action: PlatformTenantAction) => platformApi.act(id, action),
    onSuccess: (result) => {
      queryClient.setQueryData(['platform', 'tenant', id], result);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'tenants'] });
      void queryClient.invalidateQueries({ queryKey: ['platform', 'overview'] });
      setMessage({ tone: 'success', text: result.activity[0]?.summary ?? 'Saved.' });
      setDialog(null);
    },
    onError: (error) => {
      setMessage({
        tone: 'danger',
        text: error instanceof ApiRequestError ? error.message : 'Could not save.',
      });
    },
  });

  const support = useMutation({
    mutationFn: () => platformApi.supportView(id),
    onSuccess: (view) => {
      // The restaurant app in a new tab picks this token up like any session.
      storeSupportViewToken(view.token, view.tenant.workspace);
      window.open('/', '_blank', 'noopener');
      void queryClient.invalidateQueries({ queryKey: ['platform', 'tenant', id] });
    },
    onError: (error) => {
      setMessage({
        tone: 'danger',
        text: error instanceof ApiRequestError ? error.message : 'Could not open the view.',
      });
    },
  });

  if (detail.isPending) return <LoadingState label="Loading the restaurant…" />;
  if (detail.data === undefined) {
    return (
      <Page>
        <Card>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        </Card>
      </Page>
    );
  }
  const { tenant, totals, staff, sessions, activity } = detail.data;
  const bars =
    chart === 'sales'
      ? toBars(detail.data.salesPerDay, (v) => formatPaisa(v))
      : toBars(detail.data.billsPerDay, (v) => `${String(v)} bill${v === 1 ? '' : 's'}`);

  return (
    <Page>
      <PageHeader
        back={{ to: '/admin/restaurants', label: 'Restaurants' }}
        title={tenant.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
            <TenantStatusBadge status={tenant.status} />
            <span className="font-mono">{tenant.workspace}</span>
            <span>Joined {formatDateTime(tenant.createdAt)}</span>
            <span>
              {tenant.onlineNow > 0 ? null : 'Last active '}
              <LastActive iso={tenant.lastActiveAt} online={tenant.onlineNow} />
            </span>
          </span>
        }
        actions={
          <Button icon={Eye} loading={support.isPending} onClick={() => support.mutate()}>
            View as owner
          </Button>
        }
      />
      <PageBody>
        {message !== null && (
          <InlineAlert
            tone={message.tone}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            {message.text}
          </InlineAlert>
        )}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardHeader title="Owner and contact" />
            <CardBody className="grid gap-3 text-body sm:grid-cols-2">
              <div>
                <p className="text-muted-2 text-caption font-semibold">Owner</p>
                <p className="font-bold">{tenant.owner?.name ?? '—'}</p>
                <p className="text-muted text-caption">username: {tenant.owner?.username ?? '—'}</p>
              </div>
              <div className="space-y-1.5">
                {(tenant.owner?.email ?? tenant.contactEmail) && (
                  <a
                    href={`mailto:${tenant.owner?.email ?? tenant.contactEmail ?? ''}`}
                    className="text-accent-hover flex items-center gap-2 hover:underline"
                  >
                    <Mail size={15} aria-hidden />
                    {tenant.owner?.email ?? tenant.contactEmail}
                  </a>
                )}
                {tenant.phone !== '' && (
                  <a
                    href={`tel:${tenant.phone}`}
                    className="text-accent-hover flex items-center gap-2 hover:underline"
                  >
                    <Phone size={15} aria-hidden />
                    {tenant.phone}
                  </a>
                )}
                {tenant.address !== '' && <p className="text-muted">{tenant.address}</p>}
                {tenant.panNumber !== '' && <p className="text-muted">PAN {tenant.panNumber}</p>}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Account"
              description={
                <>
                  {tenant.status === 'TRIAL'
                    ? 'Trial'
                    : tenant.status === 'ACTIVE'
                      ? 'Paying'
                      : tenant.status.toLowerCase()}{' '}
                  · <TrialLeft row={tenant} />
                  {tenant.subscriptionEndsAt !== null &&
                    ` (${formatDateTime(tenant.subscriptionEndsAt)})`}
                </>
              }
            />
            <CardBody className="space-y-3">
              {tenant.statusReason !== null && tenant.status === 'SUSPENDED' && (
                <p className="text-danger-fg text-caption">Reason: {tenant.statusReason}</p>
              )}
              {tenant.subscriptionEndsAt !== null && (
                <div className="flex flex-wrap gap-2">
                  {[7, 14, 30].map((days) => (
                    <Button
                      key={days}
                      size="sm"
                      variant="secondary"
                      icon={CalendarPlus}
                      disabled={act.isPending}
                      onClick={() => act.mutate({ action: 'extend', days })}
                    >
                      +{days} days
                    </Button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {tenant.status !== 'ACTIVE' && (
                  <Button
                    size="sm"
                    icon={CheckCircle2}
                    onClick={() => {
                      setUntil('');
                      setDialog('activate');
                    }}
                  >
                    Mark as paying
                  </Button>
                )}
                {tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={RotateCcw}
                    disabled={act.isPending}
                    onClick={() => act.mutate({ action: 'reactivate' })}
                  >
                    Reactivate
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={Ban}
                    onClick={() => {
                      setReason('');
                      setDialog('suspend');
                    }}
                  >
                    Suspend
                  </Button>
                )}
              </div>
              <p className="text-muted-2 text-caption">
                Every change here is written to the restaurant’s own activity log.
              </p>
            </CardBody>
          </Card>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Orders" icon={ShoppingBag} value={totals.orders} />
          <StatCard label="Bills" icon={ReceiptText} value={totals.bills} />
          <StatCard
            label="Sales, all time"
            icon={Wallet}
            tone="accent"
            value={formatRupees(totals.salesPaisa)}
          />
          <StatCard label="Menu items" icon={BookOpen} value={totals.menuItems} />
          <StatCard label="Tables" icon={Grid3x3} value={totals.tables} />
          <StatCard label="Customers" icon={UsersRound} value={totals.customers} />
        </div>

        <Card>
          <CardHeader
            title="Last 30 days"
            description={`${String(tenant.bills30d)} bills · ${formatPaisa(tenant.sales30dPaisa)}`}
            actions={
              <Segmented
                label="Chart"
                value={chart}
                onChange={setChart}
                items={[
                  { value: 'sales', label: 'Sales' },
                  { value: 'bills', label: 'Bills' },
                ]}
              />
            }
          />
          <CardBody>
            <BarChart
              label="Last 30 days"
              data={bars}
              formatAxis={
                chart === 'sales'
                  ? formatCompactPaisa
                  : (value) => (Number.isInteger(value) ? String(value) : '')
              }
              labelEvery={5}
            />
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader
              title="Staff"
              description={`${String(staff.length)} account${staff.length === 1 ? '' : 's'}`}
            />
            <ul className="divide-border border-border divide-y border-t">
              {staff.map((member) => (
                <li key={member.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-bold">
                      {member.name}
                      {!member.isActive && (
                        <span className="text-muted-3 ml-2 text-caption font-medium">
                          (disabled)
                        </span>
                      )}
                    </p>
                    <p className="text-muted truncate text-caption">
                      {member.username}
                      {member.email !== null && ` · ${member.email}`}
                    </p>
                  </div>
                  <Badge>{member.role.toLowerCase()}</Badge>
                  <span className="text-muted-2 w-24 text-right text-caption">
                    {member.lastLoginAt === null ? 'Never' : formatRelative(member.lastLoginAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Signed-in devices"
              description="Sessions that have not expired or been signed out."
            />
            {sessions.length === 0 ? (
              <EmptyState icon={Laptop} title="Nobody signed in" className="py-8" />
            ) : (
              <ul className="divide-border border-border divide-y border-t">
                {sessions.map((session) => (
                  <li key={session.id} className="flex items-start gap-3 px-5 py-3">
                    <Laptop size={16} aria-hidden className="text-muted mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-semibold">
                        {session.staffName}
                        {session.supportView !== null && (
                          <Badge tone="warning" className="ml-2">
                            support view
                          </Badge>
                        )}
                      </p>
                      <p className="text-muted truncate text-caption">
                        {session.deviceLabel ?? 'Browser'}
                        {session.ipAddress !== null && ` · ${session.ipAddress}`}
                      </p>
                    </div>
                    <span className="text-muted-2 text-caption">
                      {formatRelative(session.lastSeenAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Activity"
            description="This restaurant’s activity log, newest first."
          />
          {activity.length === 0 ? (
            <EmptyState title="No activity yet" className="py-8" />
          ) : (
            <ul className="divide-border border-border divide-y border-t">
              {activity.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} showRestaurant={false} />
              ))}
            </ul>
          )}
        </Card>
      </PageBody>

      <Modal
        open={dialog === 'activate'}
        title={`Mark ${tenant.name} as paying`}
        description="Moves the restaurant off its trial. Leave the date empty for no end date."
        onClose={() => {
          setDialog(null);
        }}
        className="w-[min(460px,94vw)]"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
              }}
            >
              Cancel
            </Button>
            <Button
              loading={act.isPending}
              onClick={() => act.mutate({ action: 'activate', until: until === '' ? null : until })}
            >
              Mark as paying
            </Button>
          </>
        }
      >
        <Field label="Paid until (optional)">
          {({ id: fieldId }) => (
            <Input
              id={fieldId}
              type="date"
              value={until}
              onChange={(event) => {
                setUntil(event.target.value);
              }}
            />
          )}
        </Field>
      </Modal>

      <Modal
        open={dialog === 'suspend'}
        title={`Suspend ${tenant.name}`}
        description="Everyone in this restaurant is signed out and cannot sign in until it is reactivated. Their data is kept."
        onClose={() => {
          setDialog(null);
        }}
        className="w-[min(460px,94vw)]"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={act.isPending}
              disabled={reason.trim().length < 3}
              onClick={() => act.mutate({ action: 'suspend', reason: reason.trim() })}
            >
              Suspend
            </Button>
          </>
        }
      >
        <Field label="Reason (recorded in their activity log)">
          {({ id: fieldId }) => (
            <Input
              id={fieldId}
              value={reason}
              maxLength={300}
              placeholder="e.g. Payment overdue"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
      </Modal>
    </Page>
  );
}
