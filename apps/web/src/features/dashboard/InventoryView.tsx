import type { JSX } from 'react';
import { Link } from 'react-router';
import { Package, PackageCheck, PackageX } from 'lucide-react';
import type { IngredientDto } from '@nayaro/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useInventorySnapshot } from './useDashboard';
import { cn } from '@/lib/utils';

const UNIT_LABEL = { g: 'kg', ml: 'L', each: 'pcs' } as const;

/** Ingredient balances read in kitchen units: grams as kg, millilitres as litres. */
export function formatStock(milli: number, unit: IngredientDto['unit']): string {
  const base = milli / 1000;
  const value = unit === 'each' ? base : base / 1000;
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: unit === 'each' ? 0 : 2 })} ${UNIT_LABEL[unit]}`;
}

export function InventoryView(): JSX.Element {
  const inventory = useInventorySnapshot();
  if (inventory.isPending) return <LoadingState label="Loading stock…" />;
  if (inventory.data === undefined) {
    return (
      <Card>
        <ErrorState error={inventory.error} onRetry={() => void inventory.refetch()} />
      </Card>
    );
  }
  const active = inventory.data.ingredients.filter((row) => row.isActive);
  const low = active.filter((row) => row.lowStock);
  const unavailable = inventory.data.menu.filter((item) => !item.isAvailable || !item.stockAvailable);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Tracked ingredients" icon={Package} value={active.length} />
        <StatCard
          label="At or below reorder level"
          icon={PackageX}
          tone={low.length > 0 ? 'warning' : 'default'}
          value={low.length}
        />
        <StatCard
          label="Dishes unavailable"
          icon={PackageCheck}
          tone={unavailable.length > 0 ? 'danger' : 'default'}
          value={unavailable.length}
          detail="Marked off or short of stock"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card>
          <CardHeader
            title="Reorder soon"
            actions={
              <Link to="/inventory" className="text-accent-hover text-caption font-bold hover:underline">
                Manage stock
              </Link>
            }
          />
          <CardBody>
            {low.length === 0 ? (
              <EmptyState icon={PackageCheck} title="Stock levels are healthy" className="py-6" />
            ) : (
              <ul className="space-y-4">
                {low.map((row) => {
                  const ratio = row.lowStockMilli === 0 ? 1 : Math.min(1, row.onHandMilli / (row.lowStockMilli * 2));
                  return (
                    <li key={row.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{row.name}</span>
                        <span className="text-muted text-caption">
                          {formatStock(row.onHandMilli, row.unit)} left · reorder at {formatStock(row.lowStockMilli, row.unit)}
                        </span>
                      </div>
                      <div className="bg-neutral-tint h-2 rounded-full">
                        <div className={cn('h-2 rounded-full', ratio < 0.25 ? 'bg-danger' : 'bg-warn')} style={{ width: `${Math.max(4, ratio * 100)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="xl:col-span-2">
          <DataTable
            rows={active}
            getRowId={(row) => row.id}
            searchText={(row) => row.name}
            searchPlaceholder="Search ingredients"
            pageSize={8}
            initialSort={{ key: 'name', direction: 'asc' }}
            empty={{ icon: Package, title: 'No ingredients tracked yet', description: 'Add ingredients in Inventory to track stock.' }}
            columns={[
              { key: 'name', header: 'Ingredient', sortValue: (row) => row.name, cell: (row) => <span className="font-semibold">{row.name}</span> },
              {
                key: 'onHand',
                header: 'On hand',
                align: 'right',
                className: 'font-mono tabular-nums',
                sortValue: (row) => row.onHandMilli,
                cell: (row) => formatStock(row.onHandMilli, row.unit),
              },
              {
                key: 'threshold',
                header: 'Reorder at',
                align: 'right',
                hideBelow: 'sm',
                className: 'font-mono tabular-nums text-muted',
                cell: (row) => formatStock(row.lowStockMilli, row.unit),
              },
              {
                key: 'state',
                header: 'Status',
                align: 'right',
                sortValue: (row) => (row.lowStock ? 0 : 1),
                cell: (row) => (row.lowStock ? <Badge tone="warning">Low</Badge> : <Badge tone="success">OK</Badge>),
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}
