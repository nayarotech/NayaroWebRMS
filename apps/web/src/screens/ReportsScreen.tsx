import { useState, type JSX } from 'react';
import { Banknote, ChevronLeft, ChevronRight, Download, HandCoins, PiggyBank, Printer, Wallet } from 'lucide-react';
import type { DailyReportResponse } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { cn } from '@/lib/utils';
import { formatPaisa, formatRupees } from '@/lib/money';
import { formatRelative } from '@/lib/dates';
import { useSettings } from '@/features/management/hooks/useManagement';
import { useDailyReport, useDailyReportRealtime } from '@/features/reports/hooks/useDailyReport';
import { ZReportPrint } from '@/features/reports/print/ZReportPrint';
import { DayChecklist } from '@/features/reports/components/DayChecklist';
import { PaymentsCard, SalesCard } from '@/features/reports/components/MoneyCards';
import { ShiftSummary } from '@/features/reports/components/ShiftSummary';
import { CategoriesCard, ItemsCard, StaffCard } from '@/features/reports/components/SoldCards';
import { AuditTrail } from '@/features/reports/components/AuditTrail';

/**
 * End of day.
 *
 * One business day, read from the bills that were actually issued, laid out in
 * the order an owner closes up: can I close, how did we do, where did the
 * money go, does the drawer balance, and - last but read first - what was
 * changed, and by whom.
 */
export function ReportsScreen(): JSX.Element {
  const [date, setDate] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const report = useDailyReport(date);
  const settings = useSettings();
  useDailyReportRealtime();

  if (report.isPending) {
    return (
      <Page>
        <LoadingState label="Building the report…" />
      </Page>
    );
  }

  if (report.data === undefined) {
    return (
      <Page>
        <Card>
          <ErrorState
            error={report.error}
            forbiddenMessage="An owner or manager can read reports."
            onRetry={() => void report.refetch()}
          />
        </Card>
      </Page>
    );
  }

  const data = report.data;
  const today = data.expenses.currentBusinessDate;
  const isToday = data.businessDate === today;
  const goTo = (day: string): void => {
    setDate(day === today ? null : day);
  };

  return (
    <Page className={cn('transition-opacity', report.isPlaceholderData && 'opacity-60')}>
      <PageHeader
        title="End of day"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {formatLongDay(data.businessDate)}
            {isToday ? (
              <Badge tone="success" dot>
                Live · updated {formatRelative(data.generatedAt)}
              </Badge>
            ) : (
              <Badge>Past day</Badge>
            )}
          </span>
        }
        actions={
          <>
            <DayStepper
              value={data.businessDate}
              max={today}
              onChange={goTo}
              onToday={isToday ? undefined : () => {
                setDate(null);
              }}
            />
            <Button
              variant="secondary"
              icon={Download}
              disabled={data.items.length === 0}
              onClick={() => {
                downloadItemsCsv(data);
              }}
            >
              Items CSV
            </Button>
            <Button
              icon={Printer}
              onClick={() => {
                setPrinting(true);
              }}
            >
              Print Z report
            </Button>
          </>
        }
      />

      <PageBody>
        <DayChecklist report={data} />
        <Headline report={data} />

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <SalesCard report={data} />
          <PaymentsCard report={data} />
        </div>

        <Card>
          <CardHeader
            title="Cash drawer"
            description="What should be in the drawer against what was counted."
          />
          {data.shifts.length === 0 ? (
            <EmptyState icon={Wallet} title="No drawer opened" description="No cash session was opened on this day." className="py-10" />
          ) : (
            <CardBody className="grid gap-4 lg:grid-cols-2">
              {data.shifts.map((shift) => (
                <ShiftSummary key={shift.id} shift={shift} />
              ))}
            </CardBody>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
          <ItemsCard report={data} />
          <div className="flex flex-col gap-5">
            <CategoriesCard report={data} />
            <StaffCard report={data} />
          </div>
        </div>

        <AuditTrail report={data} />
      </PageBody>

      {printing && (
        <ZReportPrint
          report={data}
          restaurantName={settings.data?.restaurant.name ?? 'Nayaro RMS'}
          onDone={() => {
            setPrinting(false);
          }}
        />
      )}
    </Page>
  );
}

/** The four numbers an owner wants before anything else. */
function Headline({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  const { sales, payments, expenses, refunds, shifts } = report;
  const kept = expenses.salesLessRefundsAndExpensesPaisa;
  const expected = shifts.reduce((sum, shift) => sum + shift.expectedCashPaisa, 0);
  const counted = shifts.every((shift) => shift.close !== null);
  const variance = shifts.reduce((sum, shift) => sum + (shift.close?.variancePaisa ?? 0), 0);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Net sales"
        icon={Banknote}
        tone="accent"
        value={formatRupees(sales.grandTotalPaisa)}
        detail={`${String(sales.invoiceCount)} bill${sales.invoiceCount === 1 ? '' : 's'} · average ${formatRupees(sales.averageBillPaisa)}`}
      />
      <StatCard
        label="Left after costs"
        icon={PiggyBank}
        tone={kept < 0 ? 'danger' : 'default'}
        value={formatRupees(kept)}
        detail={`${formatRupees(expenses.totalPaisa)} expenses · ${formatRupees(refunds.totalPaisa)} refunds`}
      />
      <StatCard
        label="Cash in drawer"
        icon={Wallet}
        tone={shifts.length > 0 && (!counted || variance < 0) ? 'warning' : 'default'}
        value={shifts.length === 0 ? '—' : formatRupees(expected)}
        detail={
          shifts.length === 0
            ? 'No drawer opened'
            : !counted
              ? 'Expected · not counted yet'
              : variance === 0
                ? 'Expected · counted and balanced'
                : `Counted ${variance < 0 ? 'short' : 'over'} by ${formatPaisa(Math.abs(variance))}`
        }
      />
      <StatCard
        label="Still owed"
        icon={HandCoins}
        tone={payments.outstandingPaisa > 0 ? 'warning' : 'default'}
        value={formatRupees(payments.outstandingPaisa)}
        detail={
          payments.outstandingPaisa > 0
            ? `${String(payments.unpaidInvoiceCount)} unpaid bill${payments.unpaidInvoiceCount === 1 ? '' : 's'}`
            : 'Every bill settled'
        }
      />
    </div>
  );
}

/** Previous day, a date picker, next day - flicking back through the week is the common case. */
function DayStepper({
  value,
  max,
  onChange,
  onToday,
}: {
  readonly value: string;
  readonly max: string;
  readonly onChange: (day: string) => void;
  readonly onToday?: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="border-border-2 bg-surface flex h-10 items-center rounded-control border">
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => {
            onChange(shiftDay(value, -1));
          }}
          className="text-muted hover:text-text grid h-full w-9 place-items-center"
        >
          <ChevronLeft size={17} />
        </button>
        <input
          type="date"
          aria-label="Business day"
          value={value}
          max={max}
          onChange={(event) => {
            if (event.target.value.length > 0) onChange(event.target.value);
          }}
          className="border-border-2 text-text h-full border-x bg-transparent px-2.5 font-mono text-caption outline-none"
        />
        <button
          type="button"
          aria-label="Next day"
          disabled={value >= max}
          onClick={() => {
            onChange(shiftDay(value, 1));
          }}
          className="text-muted hover:text-text grid h-full w-9 place-items-center disabled:opacity-35"
        >
          <ChevronRight size={17} />
        </button>
      </div>
      {onToday !== undefined && (
        <Button variant="ghost" onClick={onToday}>
          Today
        </Button>
      )}
    </div>
  );
}

/** Business dates are calendar dates; stepping them in UTC keeps them from drifting. */
function shiftDay(businessDate: string, days: number): string {
  const date = new Date(`${businessDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatLongDay(businessDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${businessDate}T00:00:00Z`));
}

/**
 * Item sales as CSV, for a spreadsheet. Plain rupees with two decimals and no
 * grouping, so Excel reads them as numbers rather than text.
 */
function downloadItemsCsv(report: DailyReportResponse): void {
  const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;
  const lines = [
    ['Business day', 'Category', 'Item', 'Quantity', 'Total (NPR)'].join(','),
    ...report.items.map((item) =>
      [
        report.businessDate,
        quote(item.category),
        quote(item.name),
        String(item.quantity),
        (item.totalPaisa / 100).toFixed(2),
      ].join(','),
    ),
  ];
  // BOM so Excel opens Devanagari item names as UTF-8.
  const blob = new Blob([`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `nayaro-items-${report.businessDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
