import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/Button';
import { ApiRequestError } from '@/services/apiClient';
import { useFloor } from '@/features/floor/hooks/useFloor';
import { MenuPanel } from '@/features/orders/components/MenuPanel';
import { TransferTableDialog } from '@/features/orders/components/TransferTableDialog';
import { OrderPanel } from '@/features/orders/components/OrderPanel';
import {
  useMenu,
  useOrderEditor,
  useOrderForTarget,
  useOrderRealtime,
  type OrderTarget,
} from '@/features/orders/hooks/useOrder';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { Page, PageHeader } from '@/components/layout/Page';
import { formatPaisa } from '@/lib/money';
import { ArrowRightLeft } from 'lucide-react';

/**
 * The POS: menu on the left, the order on the right.
 *
 * One screen serves three entry points, because they differ only in what the
 * screen is pointed at:
 *
 *   #/orders/table/:tableId   the order at this table, which may not exist yet
 *   #/orders/takeaway         a new takeaway, which definitely does not
 *   #/orders/:orderId         an order that exists
 *
 * The first two render perfectly well with no Order row behind them, and that
 * is the design: opening this screen writes nothing. The row appears the
 * moment a real dish is tapped, and not before.
 */
export function OrderScreen({ mode }: { mode: 'table' | 'takeaway' | 'order' }): JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const [transferring, setTransferring] = useState(false);

  const target = useMemo((): OrderTarget => {
    if (mode === 'table') return { kind: 'TABLE', tableId: params['tableId'] ?? '' };
    if (mode === 'order') return { kind: 'ORDER', orderId: params['orderId'] ?? '' };
    return { kind: 'TAKEAWAY' };
  }, [mode, params]);

  const menu = useMenu();
  const orderQuery = useOrderForTarget(target);
  const order = orderQuery.data ?? null;
  const onEmptied = useCallback(() => {
    void navigate('/tables', { replace: true });
  }, [navigate]);
  const editor = useOrderEditor(target, order, onEmptied);
  useOrderRealtime();

  /**
   * A takeaway has no id until its first item creates one, and the URL has to
   * become that order's - otherwise a reload, or the back button, would land
   * on "new takeaway" again and start a second one.
   *
   * Driven by the add itself rather than by watching `order` appear, because
   * for a TAKEAWAY target it never does: there is nothing to fetch until the
   * order exists, so that query is disabled and its data stays null. The
   * mutation's own response is the only place the new id shows up.
   */
  const handleAdd = useCallback(
    async (menuItemId: string): Promise<void> => {
      const created = await editor.addItem(menuItemId);
      if (created !== null && target.kind !== 'ORDER') {
        void navigate(`/orders/${created.id}`, { replace: true });
      }
    },
    [editor, target, navigate],
  );

  /**
   * What to call this order on screen.
   *
   * For a table with no order yet there is nothing on the server to ask, so
   * the name comes from the floor plan the cashier just came from - already in
   * the query cache, so it costs nothing and shows "Table 4" immediately
   * rather than a placeholder that resolves a moment later.
   */
  const floor = useFloor();
  const heading = useMemo((): string => {
    if (order?.table !== null && order?.table !== undefined) return order.table.name;
    if (target.kind !== 'TABLE') return 'Takeaway';
    const named = floor.data?.areas
      .flatMap((area) => area.tables)
      .find((table) => table.id === target.tableId);
    return named?.name ?? 'Table';
  }, [order, target, floor.data]);

  // Once an order exists, keep this screen on its identity rather than its old table.
  useEffect(() => {
    if (mode === 'table' && order && orderQuery.isFetchedAfterMount) {
      void navigate(`/orders/${order.id}`, { replace: true });
    }
  }, [mode, order, orderQuery.isFetchedAfterMount, navigate]);

  const waitingForOrder =
    orderQuery.isPending || (mode === 'table' && !orderQuery.isFetchedAfterMount);

  if (orderQuery.isError && order === null) {
    return <OrderError error={orderQuery.error} onBack={() => void navigate('/tables')} />;
  }

  return (
    <Page className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        <PageHeader
          back={{ to: '/tables', label: 'Tables' }}
          title={heading}
          description="Tap a dish to add it to the order."
          actions={
            order?.canTransferTable ? (
              <Button
                variant="secondary"
                icon={ArrowRightLeft}
                disabled={editor.isSaving || waitingForOrder || orderQuery.isError}
                onClick={() => {
                  editor.dismissNotice();
                  setTransferring(true);
                  void floor.refetch();
                }}
              >
                Move table
              </Button>
            ) : undefined
          }
        />

        {menu.isPending ? (
          <LoadingState label="Loading the menu…" />
        ) : menu.isError ? (
          <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />
        ) : (
          <MenuPanel
            categories={menu.data.categories}
            busy={
              editor.isSaving ||
              waitingForOrder ||
              orderQuery.isError ||
              (order !== null && order.status !== 'DRAFT' && order.status !== 'OPEN')
            }
            onAdd={(menuItemId) => void handleAdd(menuItemId)}
          />
        )}
      </div>

      <OrderPanel order={order} heading={heading} editor={editor} />
      {order !== null && order.items.length > 0 && (
        <a
          href="#order-panel"
          className="bg-navy shadow-overlay fixed inset-x-4 bottom-4 z-20 flex items-center gap-3 rounded-card px-4 py-3 text-white md:hidden"
        >
          <span className="bg-accent grid size-8 place-items-center rounded-full text-caption font-extrabold">
            {order.items.reduce((sum, item) => sum + item.quantity, 0)}
          </span>
          <span className="font-bold">View order</span>
          <span className="ml-auto font-mono font-semibold">{formatPaisa(order.subtotalPaisa)}</span>
        </a>
      )}
      {transferring && order && (
        <TransferTableDialog
          order={order}
          floor={floor.isError ? undefined : floor.data}
          loading={floor.isFetching}
          busy={editor.isSaving}
          error={
            editor.notice ??
            (floor.isError ? 'Could not refresh the floor. Refresh before choosing a table.' : null)
          }
          onRefresh={() => void floor.refetch()}
          onClose={() => setTransferring(false)}
          onTransfer={async (tableId) => {
            const moved = await editor.transferTable(tableId);
            if (moved) void navigate(`/orders/${moved.id}`, { replace: true });
            return moved !== null;
          }}
        />
      )}
    </Page>
  );
}

function OrderError({ error, onBack }: { error: Error; onBack: () => void }): JSX.Element {
  const forbidden = error instanceof ApiRequestError && error.status === 403;

  return (
    <Page>
      <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
        <h2 className="text-[18px] font-extrabold tracking-tight">
          {forbidden ? 'Taking orders is not part of your role' : 'Could not open this order'}
        </h2>
        <p className="text-muted mt-2 text-[14px] leading-relaxed">
          {forbidden
            ? 'Kitchen accounts work from the kitchen board.'
            : error instanceof ApiRequestError && error.kind === 'http'
              ? error.message
              : 'Nayaro RMS could not be reached. Check your internet connection and try again.'}
        </p>
        <Button variant="secondary" className="mt-6" onClick={onBack}>
          Back to tables
        </Button>
      </div>
    </Page>
  );
}
