import type { JSX } from 'react';
import { Link } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Banknote, ChefHat, Grid3x3, Receipt } from 'lucide-react';
import type { PaymentMethod, SalesOverviewResponse } from '@nayaro/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/States';
import { BarChart, RankedBars } from '@/components/charts/BarChart';
import { formatCompactPaisa, formatPaisa, formatRupees } from '@/lib/money';
import { formatShortDay, formatTime } from '@/lib/dates';
import { useInvoiceHistory } from '@/features/history/hooks/useInvoiceHistory';
import { cn } from '@/lib/utils';

export const PAYMENT_LABELS: Readonly<Record<PaymentMethod, string>> = {
  CASH: 'Cash',
  QR: 'QR / wallet',
  CARD: 'Card',
  CREDIT: 'Customer credit',
};

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function Change({ value, label }: { value: number | null; label: string }): JSX.Element {
  if (value === null) return <span>{label}</span>;
  const up = value >= 0;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-flex items-center font-bold', up ? 'text-ok-fg' : 'text-danger-fg')}>
        {up ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownRight size={14} aria-hidden />}
        {Math.abs(value)}%
      </span>
      {label}
    </span>
  );
}

export function OverviewView({
  overview,
}: {
  overview: UseQueryResult<SalesOverviewResponse, Error>;
}): JSX.Element {
  if (overview.isPending) return <LoadingState label="Loading today’s figures…" />;
  if (overview.data === undefined) {
    return (
      <Card>
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      </Card>
    );
  }
  const data = overview.data;
  const today = data.days[data.days.length - 1]!;
  const sameDayLastWeek = data.days[data.days.length - 8];
  const average = today.invoiceCount === 0 ? 0 : Math.round(today.salesPaisa / today.invoiceCount);
  const { live } = data;
  const busiestHours = data.hourly.filter((slot) => slot.hour >= 7 && slot.hour <= 23);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Sales today"
          icon={Banknote}
          tone="accent"
          value={formatRupees(today.salesPaisa)}
          detail={
            <Change
              value={sameDayLastWeek === undefined ? null : percentChange(today.salesPaisa, sameDayLastWeek.salesPaisa)}
              label="vs same day last week"
            />
          }
        />
        <StatCard
          label="Bills today"
          icon={Receipt}
          value={today.invoiceCount}
          detail={`Average bill ${formatRupees(average)}`}
        />
        <StatCard
          label="Tables in service"
          icon={Grid3x3}
          value={live.occupiedTables}
          tone={live.awaitingPayment > 0 ? 'warning' : 'default'}
          detail={`${String(live.awaitingPayment)} awaiting payment · ${String(live.openTakeaways)} takeaway`}
        />
        <StatCard
          label="Kitchen queue"
          icon={ChefHat}
          value={live.kitchen.NEW + live.kitchen.PREPARING}
          tone={live.kitchen.READY > 0 ? 'warning' : 'default'}
          detail={`${String(live.kitchen.NEW)} new · ${String(live.kitchen.PREPARING)} cooking · ${String(live.kitchen.READY)} ready`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Sales, last 14 days"
            description="Issued bills by business day, including tax and charges."
            actions={
              <Link to="?view=reports" className="text-accent-hover text-caption font-bold hover:underline">
                Full report
              </Link>
            }
          />
          <CardBody>
            <BarChart
              label="Sales by business day"
              data={data.days.map((day) => ({
                key: day.businessDate,
                label: formatShortDay(day.businessDate),
                value: day.salesPaisa,
                title: formatShortDay(day.businessDate),
                detail: `${formatPaisa(day.salesPaisa)} · ${String(day.invoiceCount)} bills`,
                highlight: day.businessDate === data.businessDate,
              }))}
              formatAxis={formatCompactPaisa}
              labelEvery={2}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Payment mix" description="Money received over the same 14 days." />
          <CardBody>
            {data.paymentMix.length === 0 ? (
              <EmptyState title="No payments yet" className="py-8" />
            ) : (
              <RankedBars
                formatValue={formatRupees}
                rows={data.paymentMix.map((row) => ({
                  key: row.method,
                  label: PAYMENT_LABELS[row.method],
                  value: row.amountPaisa,
                }))}
              />
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Today by hour" description="When today’s bills were issued." />
          <CardBody>
            <BarChart
              label="Today's sales by hour"
              height={180}
              data={busiestHours.map((slot) => ({
                key: String(slot.hour),
                label: `${String(slot.hour % 12 === 0 ? 12 : slot.hour % 12)}${slot.hour < 12 ? 'a' : 'p'}`,
                value: slot.salesPaisa,
                title: `${String(slot.hour).padStart(2, '0')}:00 – ${String(slot.hour + 1).padStart(2, '0')}:00`,
                detail: `${formatPaisa(slot.salesPaisa)} · ${String(slot.invoiceCount)} bills`,
              }))}
              formatAxis={formatCompactPaisa}
              labelEvery={2}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Top dishes" description="By sales over the last 14 days." />
          <CardBody>
            {data.topItems.length === 0 ? (
              <EmptyState title="No sales yet" className="py-8" />
            ) : (
              <RankedBars
                formatValue={formatRupees}
                rows={data.topItems.slice(0, 6).map((item) => ({
                  key: item.name,
                  label: item.name,
                  value: item.salesPaisa,
                  note: `${String(item.quantity)} sold`,
                }))}
              />
            )}
          </CardBody>
        </Card>
      </div>

      <RecentBills />
    </>
  );
}

function RecentBills(): JSX.Element {
  const history = useInvoiceHistory({ date: null, status: 'ALL', q: '' });
  const invoices = history.data?.invoices.slice(0, 6) ?? [];
  return (
    <Card>
      <CardHeader
        title="Recent bills"
        actions={
          <Link to="/bills" className="text-accent-hover text-caption font-bold hover:underline">
            All bills
          </Link>
        }
      />
      {history.isPending ? (
        <LoadingState className="py-10" />
      ) : invoices.length === 0 ? (
        <EmptyState icon={Receipt} title="No bills today yet" className="py-10" />
      ) : (
        <ul className="divide-border divide-y">
          {invoices.map((invoice) => (
            <li key={invoice.id}>
              <Link
                to={`/billing/${invoice.orderId}`}
                className="hover:bg-surface-2 flex items-center gap-4 px-5 py-3"
              >
                <span className="bg-neutral-tint text-muted grid size-9 shrink-0 place-items-center rounded-control">
                  <Receipt size={16} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">
                    #{invoice.invoiceNumber} · {invoice.tableName ?? 'Takeaway'}
                  </p>
                  <p className="text-muted text-caption">
                    {formatTime(invoice.issuedAt)} · {invoice.issuedBy.name}
                  </p>
                </div>
                <InvoiceState status={invoice.status} settlement={invoice.settlementStatus} />
                <span className="w-28 text-right font-mono font-semibold tabular-nums">
                  {formatPaisa(invoice.grandTotalPaisa)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function InvoiceState({ status, settlement }: { status: string; settlement: string }): JSX.Element {
  if (status === 'VOID') return <Badge tone="danger">Void</Badge>;
  if (settlement === 'PAID') return <Badge tone="success">Paid</Badge>;
  if (settlement === 'PARTIAL') return <Badge tone="warning">Part paid</Badge>;
  return <Badge tone="warning">Unpaid</Badge>;
}
