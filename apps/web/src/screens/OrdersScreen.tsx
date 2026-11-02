import { useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChefHat, ClipboardList, CreditCard, Grid3x3, Search, ShoppingBag, Utensils } from 'lucide-react';
import { REALTIME_EVENTS, hasServicePermission, type OrderDto } from '@nayaro/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Field';
import { Segmented, Tabs } from '@/components/ui/Tabs';
import { StatCard } from '@/components/ui/StatCard';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { ORDER_KEY, useOpenOrders, useOrderRealtime } from '@/features/orders/hooks/useOrder';
import { useNow } from '@/features/kitchen/hooks/useKitchen';
import { subscribeToRealtimeEvent } from '@/services/socket';
import { formatPaisa } from '@/lib/money';
import { cn } from '@/lib/utils';

/** Where an order is in service, in the words the front desk uses. */
type Stage = 'NOT_SENT' | 'KITCHEN' | 'READY' | 'SERVED' | 'PAYMENT';

const STAGE: Record<Stage, { readonly label: string; readonly tone: BadgeTone; readonly hint: string }> = {
  NOT_SENT: { label: 'Not sent', tone: 'neutral', hint: 'Items added, nothing sent to the kitchen yet' },
  KITCHEN: { label: 'In kitchen', tone: 'warning', hint: 'The kitchen is working on it' },
  READY: { label: 'Ready to serve', tone: 'success', hint: 'Food is ready - take it out' },
  SERVED: { label: 'Served', tone: 'accent', hint: 'Guests are eating - bill when they ask' },
  PAYMENT: { label: 'Awaiting payment', tone: 'danger', hint: 'Bill issued - collect payment' },
};

function stageOf(order: OrderDto): Stage {
  if (order.status === 'BILLED') return 'PAYMENT';
  if (order.status === 'DRAFT') return 'NOT_SENT';
  if (order.kitchen.readyCount > 0) return 'READY';
  if (order.kitchen.newCount + order.kitchen.preparingCount > 0) return 'KITCHEN';
  return 'SERVED';
}

type StageFilter = 'ALL' | Stage;
type TypeFilter = 'ALL' | 'DINE_IN' | 'TAKEAWAY';

/**
 * Orders - everything in service on one list.
 *
 * The floor plan answers "which table"; this answers "which order", which is
 * what the front desk is asked all day: "is 188 ready?", "the takeaway for
 * Ram", "who still owes us?". Tables and takeaways sit together, newest work
 * at the bottom, each one a tap away from its order or its bill.
 */
export function OrdersScreen(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { staff } = useAuth();
  const orders = useOpenOrders();
  const now = useNow(30_000);
  useOrderRealtime();

  // Issuing a bill or taking a payment moves an order between columns here.
  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ORDER_KEY });
    };
    const unsubscribes = [
      subscribeToRealtimeEvent(REALTIME_EVENTS.invoiceIssued, invalidate),
      subscribeToRealtimeEvent(REALTIME_EVENTS.paymentRecorded, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient]);

  const [stage, setStage] = useState<StageFilter>('ALL');
  const [type, setType] = useState<TypeFilter>('ALL');
  const [query, setQuery] = useState('');

  const canTakeOrders = staff !== null && hasServicePermission(staff, 'TAKE_ORDERS');
  const canBill = staff?.role === 'OWNER' || staff?.role === 'MANAGER' || staff?.role === 'CASHIER';

  const all = useMemo(() => orders.data?.orders ?? [], [orders.data]);
  const counts = useMemo(() => {
    const result: Record<Stage, number> = { NOT_SENT: 0, KITCHEN: 0, READY: 0, SERVED: 0, PAYMENT: 0 };
    for (const order of all) result[stageOf(order)] += 1;
    return result;
  }, [all]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((order) => {
      if (stage !== 'ALL' && stageOf(order) !== stage) return false;
      if (type !== 'ALL' && order.type !== type) return false;
      if (needle.length === 0) return true;
      const haystack = [
        `#${String(order.orderNumber)}`,
        String(order.orderNumber),
        order.table?.name ?? 'takeaway',
        ...order.items.map((item) => item.name),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [all, stage, type, query]);

  const owed = all
    .filter((order) => order.status === 'BILLED')
    .reduce((sum, order) => sum + order.subtotalPaisa, 0);

  if (orders.isPending) {
    return (
      <Page>
        <LoadingState label="Loading orders…" />
      </Page>
    );
  }

  if (orders.data === undefined) {
    return (
      <Page>
        <Card>
          <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
        </Card>
      </Page>
    );
  }

  const open = (order: OrderDto): void => void navigate(`/orders/${order.id}`);
  const bill = (order: OrderDto): void => void navigate(`/billing/${order.id}`);

  return (
    <Page>
      <PageHeader
        title="Orders"
        description={`${String(all.length)} order${all.length === 1 ? '' : 's'} in service right now.`}
        actions={
          <>
            <Button variant="secondary" icon={Grid3x3} onClick={() => void navigate('/tables')}>
              Floor plan
            </Button>
            {canTakeOrders && (
              <Button icon={ShoppingBag} onClick={() => void navigate('/orders/takeaway')}>
                New takeaway
              </Button>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="In service" icon={ClipboardList} tone="accent" value={all.length} detail={`${String(all.filter((o) => o.type === 'TAKEAWAY').length)} takeaway`} />
        <StatCard
          label="With the kitchen"
          icon={ChefHat}
          tone={counts.KITCHEN > 0 ? 'warning' : 'default'}
          value={counts.KITCHEN}
          detail={`${String(counts.NOT_SENT)} not sent yet`}
        />
        <StatCard
          label="Ready to serve"
          icon={Utensils}
          tone={counts.READY > 0 ? 'warning' : 'default'}
          value={counts.READY}
          detail={counts.READY > 0 ? 'Take it out while it is hot' : 'Nothing waiting at the pass'}
          onClick={() => {
            setStage('READY');
          }}
        />
        <StatCard
          label="Awaiting payment"
          icon={CreditCard}
          tone={counts.PAYMENT > 0 ? 'danger' : 'default'}
          value={counts.PAYMENT}
          detail={counts.PAYMENT > 0 ? `About ${formatPaisa(owed)} before tax` : 'Nobody waiting to pay'}
          onClick={() => {
            setStage('PAYMENT');
          }}
        />
      </div>

      <Tabs
        label="Order stage"
        value={stage}
        onChange={setStage}
        className="mb-4"
        items={[
          { value: 'ALL', label: 'All', count: all.length },
          { value: 'NOT_SENT', label: 'Not sent', count: counts.NOT_SENT },
          { value: 'KITCHEN', label: 'In kitchen', count: counts.KITCHEN },
          { value: 'READY', label: 'Ready', count: counts.READY },
          { value: 'SERVED', label: 'Served', count: counts.SERVED },
          { value: 'PAYMENT', label: 'Awaiting payment', count: counts.PAYMENT },
        ]}
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search size={16} aria-hidden className="text-muted-3 absolute top-1/2 left-3 -translate-y-1/2" />
          <Input
            aria-label="Search orders"
            placeholder="Order #, table or dish…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="pl-9"
          />
        </div>
        <Segmented
          label="Order type"
          value={type}
          onChange={setType}
          items={[
            { value: 'ALL', label: 'All' },
            { value: 'DINE_IN', label: 'Dine-in' },
            { value: 'TAKEAWAY', label: 'Takeaway' },
          ]}
        />
      </div>

      {shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={all.length === 0 ? 'No orders in service' : 'No orders match'}
            description={
              all.length === 0
                ? 'Open a table on the floor plan or start a takeaway to begin.'
                : 'Try another stage, type or search.'
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              now={now}
              {...(canTakeOrders ? { onOpen: open } : {})}
              {...(canBill ? { onBill: bill } : {})}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function OrderCard({
  order,
  now,
  onOpen,
  onBill,
}: {
  readonly order: OrderDto;
  readonly now: number;
  readonly onOpen?: (order: OrderDto) => void;
  readonly onBill?: (order: OrderDto) => void;
}): JSX.Element {
  const stage = stageOf(order);
  const meta = STAGE[stage];
  const items = order.items;
  const firstTicket = order.tickets.find((ticket) => ticket.voidedAt === null);
  const minutes = firstTicket === undefined ? null : Math.max(0, Math.round((now - Date.parse(firstTicket.createdAt)) / 60_000));
  // Bill appears once there is something to bill: a draft has nothing the
  // kitchen has seen, so the order screen is the right place for it.
  const billable = onBill !== undefined && order.status !== 'DRAFT';

  return (
    <Card
      className={cn(
        'flex flex-col p-4',
        stage === 'PAYMENT' && 'border-status-payment/40',
        stage === 'READY' && 'border-status-ready/40',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-control',
            order.type === 'TAKEAWAY' ? 'bg-neutral-tint text-muted' : 'bg-accent-soft text-accent-hover',
          )}
        >
          {order.type === 'TAKEAWAY' ? <ShoppingBag size={18} aria-hidden /> : <Grid3x3 size={18} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-heading font-extrabold tracking-tight">
            {order.table?.name ?? 'Takeaway'}
            <span className="text-muted-2 ml-2 font-mono text-caption font-semibold">#{order.orderNumber}</span>
          </p>
          <p className="text-muted text-caption">
            {meta.hint}
            {minutes !== null && stage !== 'NOT_SENT' && ` · sent ${minutes < 1 ? 'just now' : `${String(minutes)} min ago`}`}
          </p>
        </div>
        <Badge tone={meta.tone} dot>
          {meta.label}
        </Badge>
      </div>

      <ul className="border-border mt-3 flex-1 space-y-1 border-t pt-3 text-body">
        {items.slice(0, 4).map((item) => (
          <li key={item.id} className="flex gap-2">
            <span className="text-muted-2 w-7 shrink-0 font-mono tabular-nums">{item.quantity}×</span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
          </li>
        ))}
        {items.length > 4 && <li className="text-muted-2 pl-9 text-caption">+{items.length - 4} more</li>}
        {items.length === 0 && <li className="text-muted-3">No items yet.</li>}
      </ul>

      {order.kitchen.ticketCount > 0 && stage !== 'PAYMENT' && (
        <p className="text-muted-2 mt-2 text-caption">
          Kitchen: {order.kitchen.newCount} new · {order.kitchen.preparingCount} cooking · {order.kitchen.readyCount} ready ·{' '}
          {order.kitchen.servedCount} served
        </p>
      )}

      <div className="border-border mt-3 flex items-center gap-2 border-t pt-3">
        <div className="mr-auto">
          <p className="text-muted-2 text-overline font-bold tracking-wider uppercase">Subtotal</p>
          <p className="font-mono text-body font-bold tabular-nums">{formatPaisa(order.subtotalPaisa)}</p>
        </div>
        {onOpen !== undefined && order.status !== 'BILLED' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onOpen(order);
            }}
          >
            Open order
          </Button>
        )}
        {billable && (
          <Button
            size="sm"
            variant={stage === 'PAYMENT' ? 'primary' : 'subtle'}
            {...(stage === 'PAYMENT' ? { icon: CreditCard } : {})}
            onClick={() => {
              onBill(order);
            }}
          >
            {stage === 'PAYMENT' ? 'Take payment' : 'Bill'}
          </Button>
        )}
      </div>
    </Card>
  );
}
