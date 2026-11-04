import { useState, type JSX, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SiteAnalyticsRange, SiteAnalyticsRow, SiteAnalyticsTotals } from '@nayaro/shared';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Tabs';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { BarChart } from '@/components/charts/BarChart';
import { cn } from '@/lib/utils';
import { platformApi } from '@/features/platform/platformApi';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** "NP" -> "🇳🇵 Nepal". Unknown stays honest rather than guessed. */
function countryLabel(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return 'Unknown';
  const flag = String.fromCodePoint(
    ...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  );
  let name = code;
  try {
    name = regionNames.of(code) ?? code;
  } catch {
    // Not a known region code; show the code itself.
  }
  return `${flag} ${name}`;
}

const STATS: readonly { key: keyof SiteAnalyticsTotals; label: string }[] = [
  { key: 'uniqueVisitors', label: 'Unique visitors' },
  { key: 'newVisitors', label: 'New visitors' },
  { key: 'visits', label: 'Visits' },
  { key: 'pageViews', label: 'Page views' },
  { key: 'pagesPerVisit', label: 'Pages per visit' },
];

/** Who visits rms.nayaro.tech, from where, and what they look at. */
export function PlatformWebsiteScreen(): JSX.Element {
  const [range, setRange] = useState<SiteAnalyticsRange>('7d');
  const [metric, setMetric] = useState<'visitors' | 'pageViews'>('visitors');
  const report = useQuery({
    queryKey: ['platform', 'website', range],
    queryFn: () => platformApi.website(range),
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
  });

  if (report.isPending) return <LoadingState label="Loading website analytics…" />;
  if (report.data === undefined) {
    return (
      <Page>
        <Card>
          <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        </Card>
      </Page>
    );
  }
  const data = report.data;
  const live = data.live;

  return (
    <Page className={cn('transition-opacity', report.isPlaceholderData && 'opacity-60')}>
      <PageHeader
        title="Website"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            Who visits rms.nayaro.tech, from where, and what they look at.
            <LiveDot active={live.visitors > 0}>
              {live.visitors} {live.visitors === 1 ? 'person' : 'people'} on the site now
            </LiveDot>
          </span>
        }
        actions={
          <Segmented
            label="Period"
            value={range}
            onChange={setRange}
            items={[
              { value: 'today', label: 'Today' },
              { value: '7d', label: '7 days' },
              { value: '30d', label: '30 days' },
              { value: '90d', label: '90 days' },
            ]}
          />
        }
      />
      <PageBody>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          {STATS.map(({ key, label }) => (
            <MetricCard
              key={key}
              label={label}
              value={data.current[key]}
              previous={data.previous?.[key] ?? null}
            />
          ))}
        </div>

        <Card>
          <CardHeader
            title="Right now"
            description="Browsers with the site open in the last 3 minutes, and restaurants working in the app."
          />
          <CardBody className="grid gap-5 lg:grid-cols-[1fr_1fr_1.2fr]">
            <div className="grid grid-cols-2 gap-3">
              <LiveFigure label="On the site" value={live.visitors} />
              <LiveFigure label="Signed in" value={live.signedIn} />
              <LiveFigure label="Restaurants online" value={live.restaurantsOnline} />
              <LiveFigure label="Staff online" value={live.staffOnline} />
            </div>
            <RankedList
              title="Viewing now"
              rows={live.pages}
              empty="Nobody on the site right now."
            />
            <RankedList title="From" rows={live.countries} format={countryLabel} empty="—" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={`${metric === 'visitors' ? 'Unique visitors' : 'Page views'} per ${data.range === 'today' ? 'hour' : 'day'}`}
            description={data.range === 'today' ? 'Last 24 hours, in your time zone.' : undefined}
            actions={
              <Segmented
                label="Chart"
                value={metric}
                onChange={setMetric}
                items={[
                  { value: 'visitors', label: 'Visitors' },
                  { value: 'pageViews', label: 'Page views' },
                ]}
              />
            }
          />
          <CardBody>
            <BarChart
              label="Visitors over time"
              data={data.series.map((bucket, index) => ({
                key: bucket.key,
                label: bucket.label,
                value: metric === 'visitors' ? bucket.visitors : bucket.pageViews,
                title: bucket.label,
                detail: `${String(bucket.visitors)} visitors · ${String(bucket.pageViews)} page views`,
                highlight: index === data.series.length - 1,
              }))}
              formatAxis={(value) => (Number.isInteger(value) ? String(value) : '')}
              labelEvery={
                data.range === 'today' ? 2 : data.range === '7d' ? 1 : data.range === '30d' ? 5 : 15
              }
            />
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <RankedCard title="Top pages" rows={data.topPages} mono />
          <RankedCard title="Where they came from" rows={data.referrers} />
          <RankedCard title="Countries" rows={data.countries} format={countryLabel} />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
          <RankedCard title="Part of the site" rows={data.areas} />
          <RankedCard
            title="Devices"
            rows={data.devices}
            format={(key) => key.charAt(0).toUpperCase() + key.slice(1)}
          />
          <RankedCard title="Browsers" rows={data.browsers} />
          <RankedCard title="Operating systems" rows={data.os} />
        </div>
        <p className="text-muted-3 text-caption">
          First-party and cookie-free: a random id in the visitor’s browser, no IP addresses stored,
          bots and the Nayaro console excluded. Countries come from the host’s edge or the device’s
          time zone.
        </p>
      </PageBody>
    </Page>
  );
}

function LiveDot({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-semibold',
        active ? 'text-ok-fg' : 'text-muted-2',
      )}
    >
      <span
        aria-hidden
        className={cn('size-2 rounded-full', active ? 'bg-ok animate-pulse' : 'bg-muted-3')}
      />
      {children}
    </span>
  );
}

function MetricCard({
  label,
  value,
  previous,
}: {
  readonly label: string;
  readonly value: number;
  readonly previous: number | null;
}): JSX.Element {
  const change =
    previous === null || previous === 0 ? null : Math.round(((value - previous) / previous) * 100);
  return (
    <div className="border-border bg-surface shadow-card rounded-card border p-4">
      <p className="text-muted font-mono text-[11px] font-semibold tracking-widest uppercase">
        {label}
      </p>
      <p className="mt-1.5 font-mono text-[1.75rem] leading-9 font-bold tabular-nums">
        {value.toLocaleString('en-IN')}
      </p>
      <p className="text-muted mt-1 text-caption">
        {change === null ? (
          'No data for the previous period'
        ) : (
          <>
            <span
              className={change >= 0 ? 'text-ok-fg font-semibold' : 'text-danger-fg font-semibold'}
            >
              {change >= 0 ? '▲' : '▼'} {Math.abs(change)}%
            </span>{' '}
            vs previous period
          </>
        )}
      </p>
    </div>
  );
}

function LiveFigure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}): JSX.Element {
  return (
    <div className="bg-surface-2 rounded-control px-3 py-2.5">
      <p className="text-muted-2 text-caption font-semibold">{label}</p>
      <p className="font-mono text-heading font-bold tabular-nums">{value}</p>
    </div>
  );
}

function RankedList({
  title,
  rows,
  format = (key) => key,
  empty,
}: {
  readonly title: string;
  readonly rows: readonly SiteAnalyticsRow[];
  readonly format?: (key: string) => string;
  readonly empty: string;
}): JSX.Element {
  return (
    <div>
      <p className="text-muted-2 mb-2 text-overline font-bold tracking-wider uppercase">{title}</p>
      {rows.length === 0 ? (
        <p className="text-muted-3 text-body">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.key} className="flex justify-between gap-3 text-body">
              <span className="truncate">{format(row.key)}</span>
              <span className="font-mono font-semibold tabular-nums">{row.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A ranked list with a soft bar behind each row, as on nayaro.tech's analytics. */
function RankedCard({
  title,
  rows,
  format = (key) => key,
  mono = false,
}: {
  readonly title: string;
  readonly rows: readonly SiteAnalyticsRow[];
  readonly format?: (key: string) => string;
  readonly mono?: boolean;
}): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <Card>
      <CardHeader
        title={title}
        actions={
          <span className="text-muted font-mono text-[11px] font-semibold tracking-widest uppercase">
            Visitors
          </span>
        }
      />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-muted-3 py-4 text-center text-body">No visits yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((row) => (
              <li key={row.key} className="relative overflow-hidden rounded-control">
                <span
                  aria-hidden
                  className="bg-accent-soft absolute inset-y-0 left-0 rounded-control"
                  style={{ width: `${String((row.value / max) * 100)}%` }}
                />
                <span className="relative flex items-center justify-between gap-3 px-3 py-2 text-body">
                  <span className={cn('truncate', mono && 'font-mono text-caption')}>
                    {format(row.key)}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{row.value}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
