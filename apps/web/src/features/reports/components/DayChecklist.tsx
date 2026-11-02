import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, CircleAlert, CircleDashed, HandCoins, ReceiptText, Wallet, type LucideIcon } from 'lucide-react';
import type { DailyReportResponse } from '@nayaro/shared';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';

type CheckState = 'done' | 'todo' | 'idle';

interface Check {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly state: CheckState;
  readonly detail: ReactNode;
}

const STATE_STYLE: Record<CheckState, { readonly mark: LucideIcon; readonly tile: string; readonly icon: string }> = {
  done: { mark: CheckCircle2, tile: 'border-ok/25 bg-ok/6', icon: 'text-ok-fg' },
  todo: { mark: CircleAlert, tile: 'border-warn/35 bg-warn/8', icon: 'text-warn-fg' },
  idle: { mark: CircleDashed, tile: 'border-border bg-surface-2', icon: 'text-muted-3' },
};

/**
 * "Can I close?" - the question an owner opens this screen with. Three checks,
 * each one either done or naming exactly what is left, so nobody has to read
 * the whole report to find the open order on table 4.
 */
export function DayChecklist({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  const { unbilledOrders, shifts, payments } = report;
  const openShifts = shifts.filter((shift) => shift.close === null);
  const variance = shifts.reduce((sum, shift) => sum + (shift.close?.variancePaisa ?? 0), 0);

  const checks: Check[] = [
    {
      key: 'orders',
      icon: ReceiptText,
      title: 'Orders billed',
      state: unbilledOrders.length === 0 ? 'done' : 'todo',
      detail:
        unbilledOrders.length === 0 ? (
          'Every order has a bill.'
        ) : (
          <>
            {unbilledOrders.length} still open:{' '}
            {unbilledOrders.map((order, index) => (
              <span key={order.orderId}>
                {index > 0 && ', '}
                <Link to={`/billing/${order.orderId}`} className="font-bold underline-offset-2 hover:underline">
                  #{order.orderNumber}
                  {` ${order.tableName ?? 'Takeaway'}`}
                </Link>
              </span>
            ))}
          </>
        ),
    },
    {
      key: 'drawer',
      icon: Wallet,
      title: 'Drawer counted',
      state: shifts.length === 0 ? 'idle' : openShifts.length > 0 ? 'todo' : 'done',
      detail:
        shifts.length === 0 ? (
          'No drawer was opened.'
        ) : openShifts.length > 0 ? (
          <>
            Not counted yet.{' '}
            <Link to="/drawer" className="font-bold underline-offset-2 hover:underline">
              Count the drawer
            </Link>
          </>
        ) : variance === 0 ? (
          'Counted and balanced.'
        ) : (
          `Counted, ${variance < 0 ? 'short' : 'over'} by ${formatPaisa(Math.abs(variance))}.`
        ),
    },
    {
      key: 'owed',
      icon: HandCoins,
      title: 'Bills settled',
      state: payments.outstandingPaisa === 0 ? 'done' : 'todo',
      detail:
        payments.outstandingPaisa === 0
          ? 'Nothing left unpaid.'
          : `${formatPaisa(payments.outstandingPaisa)} owed on ${String(payments.unpaidInvoiceCount)} bill${payments.unpaidInvoiceCount === 1 ? '' : 's'}.`,
    },
  ];

  const left = checks.filter((check) => check.state === 'todo').length;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-control',
            left === 0 ? 'bg-ok/12 text-ok-fg' : 'bg-warn/14 text-warn-fg',
          )}
        >
          {left === 0 ? <CheckCircle2 size={20} aria-hidden /> : <CircleAlert size={20} aria-hidden />}
        </span>
        <div>
          <h2 className="text-heading font-extrabold tracking-tight">
            {left === 0 ? 'Ready to close' : `${String(left)} thing${left === 1 ? '' : 's'} to finish before closing`}
          </h2>
          <p className="text-muted text-caption">
            {left === 0
              ? 'Every order is billed, the drawer is counted and nothing is owed.'
              : 'The figures below can still change until these are done.'}
          </p>
        </div>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {checks.map((check) => {
          const style = STATE_STYLE[check.state];
          const Mark = style.mark;
          const Icon = check.icon;
          return (
            <li key={check.key} className={cn('flex gap-3 rounded-control border px-3.5 py-3', style.tile)}>
              <Icon aria-hidden size={18} className="text-muted mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-bold">{check.title}</p>
                <p className="text-muted mt-0.5 text-caption">{check.detail}</p>
              </div>
              <Mark aria-label={check.state} size={18} className={cn('mt-0.5 shrink-0', style.icon)} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
