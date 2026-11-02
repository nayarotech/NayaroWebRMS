import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { CalendarCheck, Crown, Receipt, TrendingUp } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Tabs';
import { StatCard } from '@/components/ui/StatCard';
import { DataTable } from '@/components/ui/DataTable';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { BarChart, RankedBars } from '@/components/charts/BarChart';
import { formatCompactPaisa, formatPaisa, formatRupees } from '@/lib/money';
import { formatShortDay } from '@/lib/dates';
import { useSalesOverview } from './useDashboard';
import { PAYMENT_LABELS } from './OverviewView';

type Range = '7' | '14' | '30';

/** Sales over a chosen period. The day-by-day Z report lives on End of day. */
export function ReportsView(): JSX.Element {
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>('14');
  const overview = useSalesOverview(Number(range));

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        label="Report period"
        value={range}
        onChange={setRange}
        items={[
          { value: '7', label: '7 days' },
          { value: '14', label: '14 days' },
          { value: '30', label: '30 days' },
        ]}
      />
      <Button variant="secondary" icon={CalendarCheck} className="ml-auto" onClick={() => void navigate('/reports')}>
        End-of-day report
      </Button>
    </div>
  );

  if (overview.isPending) return <>{toolbar}<LoadingState /></>;
  if (overview.data === undefined) {
    return (
      <>
        {toolbar}
        <Card>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      </>
    );
  }

  const { days, topItems, paymentMix } = overview.data;
  const total = days.reduce((sum, day) => sum + day.salesPaisa, 0);
  const bills = days.reduce((sum, day) => sum + day.invoiceCount, 0);
  const best = days.reduce((top, day) => (day.salesPaisa > top.salesPaisa ? day : top), days[0]!);
  const trading = days.filter((day) => day.invoiceCount > 0).length;

  return (
    <>
      {toolbar}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={`Sales, ${range} days`} icon={TrendingUp} tone="accent" value={formatRupees(total)} />
        <StatCard
          label="Bills"
          icon={Receipt}
          value={bills}
          detail={`Average ${formatRupees(bills === 0 ? 0 : total / bills)}`}
        />
        <StatCard
          label="Daily average"
          icon={CalendarCheck}
          value={formatRupees(trading === 0 ? 0 : total / trading)}
          detail={`${String(trading)} trading days`}
        />
        <StatCard
          label="Best day"
          icon={Crown}
          value={formatRupees(best.salesPaisa)}
          detail={formatShortDay(best.businessDate)}
        />
      </div>

      <Card>
        <CardHeader title="Daily sales" description="Issued bills per business day, including tax and charges." />
        <CardBody>
          <BarChart
            label="Daily sales"
            data={days.map((day) => ({
              key: day.businessDate,
              label: formatShortDay(day.businessDate),
              value: day.salesPaisa,
              title: formatShortDay(day.businessDate),
              detail: `${formatPaisa(day.salesPaisa)} · ${String(day.invoiceCount)} bills`,
              highlight: day.businessDate === best.businessDate,
            }))}
            formatAxis={formatCompactPaisa}
            labelEvery={range === '30' ? 4 : range === '14' ? 2 : 1}
          />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <DataTable
            rows={topItems}
            getRowId={(row) => row.name}
            searchText={(row) => row.name}
            searchPlaceholder="Search dishes"
            initialSort={{ key: 'sales', direction: 'desc' }}
            pageSize={8}
            empty={{ title: 'No dishes sold in this period' }}
            columns={[
              { key: 'name', header: 'Top dishes', cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: 'qty', header: 'Sold', align: 'right', cell: (row) => row.quantity, sortValue: (row) => row.quantity },
              {
                key: 'sales',
                header: 'Sales',
                align: 'right',
                className: 'font-mono tabular-nums',
                cell: (row) => formatPaisa(row.salesPaisa),
                sortValue: (row) => row.salesPaisa,
              },
            ]}
          />
        </div>
        <Card>
          <CardHeader title="Payment methods" description="Money received in this period." />
          <CardBody>
            <RankedBars
              formatValue={formatRupees}
              rows={paymentMix.map((row) => ({
                key: row.method,
                label: PAYMENT_LABELS[row.method],
                value: row.amountPaisa,
                note: total === 0 ? undefined : `${String(Math.round((row.amountPaisa / total) * 100))}%`,
              }))}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
