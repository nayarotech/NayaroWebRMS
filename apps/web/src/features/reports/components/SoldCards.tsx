import { useState, type JSX } from 'react';
import { UtensilsCrossed } from 'lucide-react';
import type { DailyReportResponse, ItemSalesDto } from '@nayaro/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Segmented } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/States';
import { RankedBars } from '@/components/charts/BarChart';
import { formatPaisa, formatRupees } from '@/lib/money';

const TOP = 8;

const ITEM_COLUMNS: readonly Column<ItemSalesDto>[] = [
  {
    key: 'name',
    header: 'Item',
    cell: (item) => <span className="font-semibold">{item.name}</span>,
    sortValue: (item) => item.name.toLowerCase(),
  },
  {
    key: 'category',
    header: 'Category',
    cell: (item) => <span className="text-muted">{item.category}</span>,
    sortValue: (item) => item.category.toLowerCase(),
    hideBelow: 'sm',
  },
  {
    key: 'quantity',
    header: 'Qty',
    cell: (item) => <span className="font-mono tabular-nums">{item.quantity}</span>,
    sortValue: (item) => item.quantity,
    align: 'right',
  },
  {
    key: 'total',
    header: 'Sales',
    cell: (item) => <span className="font-mono tabular-nums">{formatPaisa(item.totalPaisa)}</span>,
    sortValue: (item) => item.totalPaisa,
    align: 'right',
  },
];

/** What sold: the top sellers at a glance, every item one click away. */
export function ItemsCard({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  const [view, setView] = useState<'top' | 'all'>('top');
  const ranked = [...report.items].sort((a, b) => b.totalPaisa - a.totalPaisa);

  return (
    <Card>
      <CardHeader
        title="What sold"
        description="Before bill discounts, service charge and VAT."
        actions={
          report.items.length > TOP ? (
            <Segmented
              label="Items shown"
              value={view}
              onChange={setView}
              items={[
                { value: 'top', label: `Top ${String(TOP)}` },
                { value: 'all', label: `All ${String(report.items.length)}` },
              ]}
            />
          ) : undefined
        }
      />
      {report.items.length === 0 ? (
        <EmptyState icon={UtensilsCrossed} title="Nothing sold" className="py-10" />
      ) : view === 'top' ? (
        <CardBody>
          <RankedBars
            formatValue={formatRupees}
            rows={ranked.slice(0, TOP).map((item) => ({
              key: `${item.category}:${item.name}`,
              label: item.name,
              note: `${String(item.quantity)} sold`,
              value: item.totalPaisa,
            }))}
          />
        </CardBody>
      ) : (
        <DataTable
          rows={ranked}
          columns={ITEM_COLUMNS}
          getRowId={(item) => `${item.category}:${item.name}`}
          searchText={(item) => `${item.name} ${item.category}`}
          searchPlaceholder="Search items…"
          initialSort={{ key: 'total', direction: 'desc' }}
          empty={{ title: 'No matching items' }}
        />
      )}
    </Card>
  );
}

export function CategoriesCard({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  return (
    <Card>
      <CardHeader title="Categories" />
      <CardBody>
        {report.categories.length === 0 ? (
          <p className="text-muted-3 text-body">Nothing sold.</p>
        ) : (
          <RankedBars
            formatValue={formatRupees}
            rows={[...report.categories]
              .sort((a, b) => b.totalPaisa - a.totalPaisa)
              .map((category) => ({
                key: category.category,
                label: category.category,
                note: `${String(category.quantity)} sold`,
                value: category.totalPaisa,
              }))}
          />
        )}
      </CardBody>
    </Card>
  );
}

export function StaffCard({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  return (
    <Card>
      <CardHeader title="Bills by staff" description="Who issued the bills, by value." />
      <CardBody>
        {report.staff.length === 0 ? (
          <p className="text-muted-3 text-body">No bills issued.</p>
        ) : (
          <RankedBars
            formatValue={formatRupees}
            rows={[...report.staff]
              .sort((a, b) => b.grandTotalPaisa - a.grandTotalPaisa)
              .map((row) => ({
                key: row.staff.id,
                label: row.staff.name,
                note: `${String(row.invoiceCount)} bill${row.invoiceCount === 1 ? '' : 's'}`,
                value: row.grandTotalPaisa,
              }))}
          />
        )}
      </CardBody>
    </Card>
  );
}
