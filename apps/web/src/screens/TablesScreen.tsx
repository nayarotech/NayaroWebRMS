import { hasServicePermission } from '@nayaro/shared';
import { ChefHat, CreditCard, Grid3x3, Utensils } from 'lucide-react';
import { StatCard } from '@/components/ui/StatCard';
import { useCallback, useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import type { FloorArea, FloorTable, OrderDto, TableStatus } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { ApiRequestError } from '@/services/apiClient';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { AreaTabs, type AreaSelection } from '@/features/floor/components/AreaTabs';
import { FloorEmptyState } from '@/features/floor/components/FloorEmptyState';
import { FloorSettingsDialog } from '@/features/floor/components/FloorSettingsDialog';
import { TableGrid } from '@/features/floor/components/TableGrid';
import { TableEditorDialog, type TableEditorTarget } from '@/features/floor/components/TableEditorDialog';
import { useFloor, useFloorRealtime } from '@/features/floor/hooks/useFloor';
import { useOpenTakeaways } from '@/features/orders/hooks/useOrder';
import { formatPaisa } from '@/lib/money';
import { TABLE_STATUS_ORDER, TABLE_STATUS_PRESENTATION } from '@/features/floor/tableStatus';
import { cn } from '@/lib/utils';
import { Page, PageHeader } from '@/components/layout/Page';
import { LoadingState } from '@/components/ui/States';

/**
 * The floor plan - the screen a restaurant actually lives on.
 *
 * It answers one question at a glance: which tables need someone right now,
 * and it is the way into every order: tapping a table opens its POS screen -
 * the order already on it, or an empty one waiting for a first item.
 */
export function TablesScreen(): JSX.Element {
  const navigate = useNavigate();
  const { staff } = useAuth();
  const floor = useFloor();
  const takeaways = useOpenTakeaways();
  useFloorRealtime();

  const [selection, setSelection] = useState<AreaSelection>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<TableEditorTarget | null>(null);

  const canConfigure = staff?.role === 'OWNER' || staff?.role === 'MANAGER';
  const canTakeOrders = staff !== null && hasServicePermission(staff, 'TAKE_ORDERS');

  /*
   * Who may open a bill. The same three the billing API accepts - a WAITER is
   * excluded here exactly as it is there, because taking money is the one
   * thing that separates the two front-of-house roles.
   */
  const canBill = staff?.role === 'OWNER' || staff?.role === 'MANAGER' || staff?.role === 'CASHIER';

  const billTable = useCallback(
    (table: FloorTable) => {
      // Addressed by TABLE, not by order id. The floor board may be a moment
      // stale, and the route resolves whatever order is on the table when it
      // opens - so a closed order produces an honest message rather than a
      // bill for something that no longer exists.
      void navigate(`/billing/table/${table.id}`);
    },
    [navigate],
  );

  const openTable = useCallback(
    (table: FloorTable) => {
      // An existing order keeps its identity when it moves tables. Empty tables
      // resolve their order on opening, then switch to the new order's URL.
      void navigate(
        table.activeOrderId ? `/orders/${table.activeOrderId}` : `/orders/table/${table.id}`,
      );
    },
    [navigate],
  );
  const areas = useMemo(() => floor.data?.areas ?? [], [floor.data]);
  const visibleAreas = useMemo(
    () => (selection === null ? areas : areas.filter((area) => area.id === selection)),
    [areas, selection],
  );
  const counts = useMemo(() => countByStatus(areas), [areas]);
  const totalTables = areas.reduce((count, area) => count + area.tables.length, 0);

  // A background refetch that fails leaves `data` in place and `isSuccess`
  // true, so the screen would keep showing a stale board as if it were live.
  // The comparison is what distinguishes "we have data" from "our data is
  // still current" - the same lesson the Phase 2 status screen taught.
  const isStale = floor.errorUpdatedAt > floor.dataUpdatedAt;

  if (floor.isPending) {
    return (
      <Page>
        <LoadingState label="Loading the floor plan…" />
      </Page>
    );
  }

  if (floor.isError && floor.data === undefined) {
    return <FloorError error={floor.error} canConfigure={canConfigure} />;
  }

  return (
    <Page>
      <PageHeader
        title="Floor plan"
        description={
          <>
            {totalTables === 0
              ? 'No tables yet.'
              : `${String(totalTables)} ${totalTables === 1 ? 'table' : 'tables'} across ${String(areas.length)} ${areas.length === 1 ? 'area' : 'areas'}.`}
          </>
        }
        actions={
          <>
            <div className="ml-auto flex items-center gap-2.5">
              {isStale && (
                <span
                  role="status"
                  className="text-warn-fg border-warn/40 bg-warn/10 rounded-xl border px-3 py-2 text-[12px] font-bold"
                >
                  Not live — reconnecting
                </span>
              )}
              {canTakeOrders && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigate('/orders/takeaway');
                  }}
                >
                  + Takeaway
                </Button>
              )}
              {canConfigure && areas.length > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSettingsOpen(true);
                  }}
                >
                  Areas and tables
                </Button>
              )}
            </div>
          </>
        }
      />

      {areas.length === 0 ? (
        <FloorEmptyState
          canConfigure={canConfigure}
          onConfigure={() => {
            setSettingsOpen(true);
          }}
        />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard
              label="Tables in use"
              icon={Grid3x3}
              tone="accent"
              value={
                <>
                  {totalTables - counts.AVAILABLE}
                  <span className="text-muted-3 text-heading"> / {totalTables}</span>
                </>
              }
              detail={`${String(counts.AVAILABLE)} free to seat`}
            />
            <StatCard
              label="With the kitchen"
              icon={ChefHat}
              tone={counts.PREPARING > 0 ? 'warning' : 'default'}
              value={counts.PREPARING}
            />
            <StatCard
              label="Ready to serve"
              icon={Utensils}
              tone={counts.READY > 0 ? 'warning' : 'default'}
              value={counts.READY}
            />
            <StatCard
              label="Awaiting payment"
              icon={CreditCard}
              tone={counts.AWAITING_PAYMENT > 0 ? 'danger' : 'default'}
              value={counts.AWAITING_PAYMENT}
            />
          </div>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <AreaTabs areas={areas} selected={selection} onSelect={setSelection} />
            <StatusLegend counts={counts} />
          </div>
          {canTakeOrders && (
            <TakeawayStrip
              orders={takeaways.data?.orders ?? []}
              onOpen={(orderId) => void navigate(`/orders/${orderId}`)}
            />
          )}
          <TableGrid
            areas={visibleAreas}
            showAreaNames={selection === null}
            {...(canTakeOrders ? { onOpenTable: openTable } : {})}
            {...(canBill ? { onBillTable: billTable } : {})}
            {...(canConfigure
              ? {
                  onAddTable: (area: FloorArea) => {
                    setEditorTarget({ mode: 'add', areaId: area.id });
                  },
                  onEditTable: (table: FloorTable, area: FloorArea) => {
                    setEditorTarget({ mode: 'edit', table, areaId: area.id });
                  },
                }
              : {})}
          />
        </>
      )}

      {canConfigure && (
        <TableEditorDialog
          target={editorTarget}
          areas={areas}
          onClose={() => {
            setEditorTarget(null);
          }}
        />
      )}
      {canConfigure && (
        <FloorSettingsDialog
          open={settingsOpen}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
    </Page>
  );
}

/**
 * Open takeaways.
 *
 * A takeaway has no table, so the board below cannot show it. Without this
 * strip an order started at the counter disappeared the moment the cashier
 * walked back to the floor plan - still open, still holding an order number,
 * and reachable only by a URL nobody had written down.
 *
 * Only work in progress appears here. A paid takeaway leaves, which is what
 * keeps the strip short enough to scan.
 */
function TakeawayStrip({
  orders,
  onOpen,
}: {
  orders: readonly OrderDto[];
  onOpen: (orderId: string) => void;
}): JSX.Element | null {
  if (orders.length === 0) return null;

  return (
    <section aria-label="Open takeaways" className="mb-6">
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-[13px] font-extrabold tracking-tight">Takeaway</h2>
        <span className="text-muted-2 font-mono text-[11px] font-semibold">
          {orders.length} open
        </span>
      </div>
      <div className="flex flex-wrap gap-3">
        {orders.map((order) => (
          <button
            key={order.id}
            type="button"
            aria-label={`Takeaway order ${String(order.orderNumber)}, ${order.status.toLowerCase()}`}
            onClick={() => {
              onOpen(order.id);
            }}
            className={cn(
              'border-border-2 bg-surface min-w-[168px] rounded-card border p-3.5 text-left',
              'hover:border-accent focus-visible:ring-accent-hover/50 transition-colors outline-none focus-visible:ring-2',
            )}
          >
            <p className="text-[15px] font-extrabold tracking-tight">Order #{order.orderNumber}</p>
            <p className="text-muted-2 text-[11.5px] font-semibold">
              {order.status === 'DRAFT'
                ? 'Not sent yet'
                : order.status === 'OPEN'
                  ? 'With the kitchen'
                  : 'Awaiting payment'}
            </p>
            <p className="mt-1.5 font-mono text-[13px] font-bold">
              {formatPaisa(order.subtotalPaisa)}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Legend and live tally in one control. Reading the colours and counting what
 * needs attention are the same act, so they are the same component; and a
 * legend that shows zeroes still teaches what the colours mean on a quiet
 * afternoon, which is when someone new is being shown the till.
 */
function StatusLegend({ counts }: { counts: Record<TableStatus, number> }): JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {TABLE_STATUS_ORDER.map((status) => {
        const presentation = TABLE_STATUS_PRESENTATION[status];
        const count = counts[status];
        return (
          <li key={status} className="flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2 rounded-full', presentation.dot)} />
            <span
              className={cn(
                'text-[12px] font-bold',
                count === 0 ? 'text-muted-3' : presentation.text,
              )}
            >
              {presentation.label}
            </span>
            <span className="text-muted-2 font-mono text-[11px] font-semibold">{count}</span>
          </li>
        );
      })}
    </ul>
  );
}

function FloorError({ error, canConfigure }: { error: Error; canConfigure: boolean }): JSX.Element {
  // 403 is not a fault - it is a kitchen account looking at a screen that is
  // not theirs. Saying so beats an error box that implies something broke.
  const forbidden = error instanceof ApiRequestError && error.status === 403;

  return (
    <Page>
      <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
        <h2 className="text-[18px] font-extrabold tracking-tight">
          {forbidden ? 'The floor plan is not part of your role' : 'Could not load the floor plan'}
        </h2>
        <p className="text-muted mt-2 text-[14px] leading-relaxed">
          {forbidden
            ? 'Kitchen accounts work from the kitchen board.'
            : error instanceof ApiRequestError && error.kind === 'http'
              ? error.message
              : 'Nayaro RMS could not be reached. Check your internet connection and try again.'}
        </p>
        {!forbidden && !canConfigure && (
          <p className="text-muted-2 mt-3 text-[13px]">Ask a manager if this continues.</p>
        )}
      </div>
    </Page>
  );
}

function countByStatus(areas: readonly FloorArea[]): Record<TableStatus, number> {
  const counts: Record<TableStatus, number> = {
    AVAILABLE: 0,
    OCCUPIED: 0,
    PREPARING: 0,
    READY: 0,
    AWAITING_PAYMENT: 0,
  };
  for (const area of areas) {
    for (const table of area.tables) counts[table.status] += 1;
  }
  return counts;
}
