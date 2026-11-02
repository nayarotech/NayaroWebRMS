import type { JSX } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChefHat, ClipboardList, ShoppingBag } from 'lucide-react';
import type { OrderDto, TableStatus } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useFloor } from '@/features/floor/hooks/useFloor';
import { TABLE_STATUS_PRESENTATION } from '@/features/floor/tableStatus';
import { useKitchenTickets, useNow } from '@/features/kitchen/hooks/useKitchen';
import { formatPaisa } from '@/lib/money';

const STATUS_TONE: Readonly<Record<TableStatus, BadgeTone>> = {
  AVAILABLE: 'neutral',
  OCCUPIED: 'accent',
  PREPARING: 'warning',
  READY: 'success',
  AWAITING_PAYMENT: 'danger',
};

/** Everything currently in service: occupied tables, takeaways and the kitchen line. */
export function OrdersView(): JSX.Element {
  const floor = useFloor();
  const takeaways = useQuery({
    queryKey: ['orders', 'takeaway', 'open'],
    queryFn: () => apiClient.get<{ orders: OrderDto[] }>('/orders/takeaway/open'),
    refetchInterval: 15_000,
  });
  const kitchen = useKitchenTickets();
  const now = useNow(30_000);

  const busyTables =
    floor.data?.areas.flatMap((area) =>
      area.tables
        .filter((table) => table.status !== 'AVAILABLE')
        .map((table) => ({ ...table, area: area.name })),
    ) ?? [];

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader
          title="Tables in service"
          description="Select a table to open its order or bill."
          actions={
            <Link to="/tables" className="text-accent-hover text-caption font-bold hover:underline">
              Floor plan
            </Link>
          }
        />
        {floor.isPending ? (
          <LoadingState className="py-10" />
        ) : floor.isError ? (
          <ErrorState error={floor.error} onRetry={() => void floor.refetch()} />
        ) : busyTables.length === 0 ? (
          <EmptyState icon={ClipboardList} title="Every table is free" description="New orders appear here as tables are seated." />
        ) : (
          <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
            {busyTables.map((table) => (
              <Link
                key={table.id}
                to={table.status === 'AWAITING_PAYMENT' ? `/billing/table/${table.id}` : `/orders/table/${table.id}`}
                className="border-border hover:border-border-4 rounded-card border p-3.5 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-heading font-extrabold">{table.name}</span>
                  <Badge tone={STATUS_TONE[table.status]} dot>
                    {TABLE_STATUS_PRESENTATION[table.status].label}
                  </Badge>
                </div>
                <p className="text-muted mt-1 text-caption">
                  {table.area} · seats {table.capacity}
                </p>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Open takeaways" />
          {takeaways.isPending ? (
            <LoadingState className="py-8" />
          ) : (takeaways.data?.orders.length ?? 0) === 0 ? (
            <EmptyState icon={ShoppingBag} title="No open takeaways" className="py-8" />
          ) : (
            <ul className="divide-border divide-y">
              {takeaways.data?.orders.map((order) => (
                <li key={order.id}>
                  <Link to={`/orders/${order.id}`} className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3">
                    <span className="font-bold">Order #{order.orderNumber}</span>
                    <span className="text-muted text-caption">{order.items.length} items</span>
                    <span className="ml-auto font-mono text-caption font-semibold">{formatPaisa(order.subtotalPaisa)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Kitchen line"
            actions={
              <Link to="/kitchen" className="text-accent-hover text-caption font-bold hover:underline">
                Open board
              </Link>
            }
          />
          {kitchen.isPending ? (
            <LoadingState className="py-8" />
          ) : (kitchen.data?.tickets.length ?? 0) === 0 ? (
            <EmptyState icon={ChefHat} title="Kitchen is clear" className="py-8" />
          ) : (
            <ul className="divide-border divide-y">
              {kitchen.data?.tickets.slice(0, 8).map((ticket) => (
                <li key={ticket.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="font-bold">KOT {ticket.kotNumber}</span>
                  <span className="text-muted min-w-0 flex-1 truncate text-caption">
                    {ticket.tableName ?? 'Takeaway'} · {Math.max(0, Math.round((now - Date.parse(ticket.createdAt)) / 60_000))} min
                  </span>
                  <Badge tone={ticket.status === 'READY' ? 'success' : ticket.status === 'NEW' ? 'accent' : 'warning'}>
                    {ticket.status === 'NEW' ? 'New' : ticket.status === 'PREPARING' ? 'Cooking' : 'Ready'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
