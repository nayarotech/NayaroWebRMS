import { useState, type JSX } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Clock, MailQuestion, Radio, Store, UserPlus } from 'lucide-react';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Segmented } from '@/components/ui/Tabs';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { BarChart } from '@/components/charts/BarChart';
import { formatPaisa, formatRupees } from '@/lib/money';
import { formatRelative } from '@/lib/dates';
import { platformApi } from '@/features/platform/platformApi';
import { cn } from '@/lib/utils';
import { ActivityRow, TenantStatusBadge, TrialLeft, toBars } from '@/features/platform/parts';

type Series = 'signups' | 'active' | 'bills';

/** Nayaro across every restaurant: growth, trials, usage, and what is happening now. */
export function PlatformOverviewScreen(): JSX.Element {
  const [series, setSeries] = useState<Series>('signups');
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: platformApi.overview,
    refetchInterval: 30_000,
  });

  if (overview.isPending) return <LoadingState label="Loading the overview…" />;
  if (overview.data === undefined) {
    return (
      <Page>
        <Card>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      </Page>
    );
  }
  const data = overview.data;
  const t = data.tenants;
  const chart =
    series === 'signups'
      ? toBars(data.signupsPerDay, (v) => `${String(v)} new restaurant${v === 1 ? '' : 's'}`)
      : series === 'active'
        ? toBars(data.activeRestaurantsPerDay, (v) => `${String(v)} restaurant${v === 1 ? '' : 's'} used the app`)
        : toBars(data.billsPerDay, (v) => `${String(v)} bill${v === 1 ? '' : 's'} issued`);

  return (
    <Page>
      <PageHeader
        title="Overview"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            Every restaurant on Nayaro RMS.
            <span
              className={cn(
                'inline-flex items-center gap-1.5 font-semibold',
                data.onlineNow.people > 0 ? 'text-ok-fg' : 'text-muted-2',
              )}
            >
              <span
                aria-hidden
                className={cn('size-2 rounded-full', data.onlineNow.people > 0 ? 'bg-ok animate-pulse' : 'bg-muted-3')}
              />
              {data.onlineNow.people} {data.onlineNow.people === 1 ? 'person' : 'people'} in {data.onlineNow.restaurants}{' '}
              restaurant{data.onlineNow.restaurants === 1 ? '' : 's'} right now
            </span>
          </span>
        }
      />
      <PageBody>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Restaurants"
            icon={Store}
            tone="accent"
            value={t.total}
            detail={`${String(t.active)} paying · ${String(t.trial)} on trial · ${String(t.suspended)} suspended`}
          />
          <StatCard
            label="Trials ending in 7 days"
            icon={Clock}
            tone={t.trialEndingSoon > 0 ? 'warning' : 'default'}
            value={t.trialEndingSoon}
            detail={`${String(t.trialExpired)} trial${t.trialExpired === 1 ? '' : 's'} already ended`}
          />
          <StatCard
            label="Active restaurants"
            icon={Radio}
            value={data.activeRestaurants.today}
            detail={`today · ${String(data.activeRestaurants.week)} this week`}
          />
          <StatCard
            label="Sales through Nayaro, 30 days"
            icon={Banknote}
            value={formatRupees(data.bills.sales30dPaisa)}
            detail={`${String(data.bills.last30d)} bills · ${String(data.bills.today)} today`}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard label="New restaurants this week" icon={UserPlus} value={t.newThisWeek} />
          <Link to="/admin/signups" className="block">
            <StatCard
              label="Unfinished sign-ups"
              icon={MailQuestion}
              tone={data.pendingSignups > 0 ? 'warning' : 'default'}
              value={data.pendingSignups}
              detail="Started registering, code not entered yet"
            />
          </Link>
        </div>

        <Card>
          <CardHeader
            title="Last 30 days"
            actions={
              <Segmented
                label="Chart"
                value={series}
                onChange={setSeries}
                items={[
                  { value: 'signups', label: 'Sign-ups' },
                  { value: 'active', label: 'Active restaurants' },
                  { value: 'bills', label: 'Bills' },
                ]}
              />
            }
          />
          <CardBody>
            <BarChart
              label="Last 30 days"
              data={chart}
              formatAxis={(value) => String(Math.round(value))}
              labelEvery={5}
            />
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader title="Trials ending soon" description="Talk to them before the trial runs out." />
            {data.trialsEndingSoon.length === 0 ? (
              <EmptyState icon={Clock} title="No trials ending this week" className="py-8" />
            ) : (
              <ul className="divide-border border-border divide-y border-t">
                {data.trialsEndingSoon.map((row) => (
                  <li key={row.id}>
                    <Link
                      to={`/admin/restaurants/${row.id}`}
                      className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-bold">{row.name}</p>
                        <p className="text-muted truncate text-caption">
                          {row.owner?.name ?? '—'} · {row.owner?.email ?? row.contactEmail ?? row.phone ?? ''}
                        </p>
                      </div>
                      <span className="text-caption">
                        <TrialLeft row={row} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Newest restaurants"
              actions={
                <Link to="/admin/restaurants" className="text-accent-hover text-caption font-bold hover:underline">
                  All restaurants
                </Link>
              }
            />
            <ul className="divide-border border-border divide-y border-t">
              {data.recentSignups.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/restaurants/${row.id}`} className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-bold">{row.name}</p>
                      <p className="text-muted truncate text-caption">
                        Joined {formatRelative(row.createdAt)} · {row.bills30d} bills · {formatPaisa(row.sales30dPaisa)}
                      </p>
                    </div>
                    <TenantStatusBadge status={row.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Happening now"
            description="Sign-ups, sign-ins, staff changes and account events across every restaurant."
            actions={
              <Link to="/admin/activity" className="text-accent-hover text-caption font-bold hover:underline">
                Full activity
              </Link>
            }
          />
          <ul className="divide-border border-border divide-y border-t">
            {data.recentActivity.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </Card>
      </PageBody>
    </Page>
  );
}
