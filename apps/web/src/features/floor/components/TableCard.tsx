import type { JSX } from 'react';
import { Pencil } from 'lucide-react';
import type { FloorTable } from '@nayaro/shared';
import { cn } from '@/lib/utils';
import { TABLE_STATUS_PRESENTATION } from '../tableStatus';
import { TableStatusBadge } from './TableStatusBadge';

export interface TableCardProps {
  readonly table: FloorTable;
  /** The area it sits in. Shown only when areas are being displayed together. */
  readonly areaName?: string;
  /** Opens the order for this table. Omitted for roles that cannot take orders. */
  readonly onOpen?: (table: FloorTable) => void;
  /**
   * Opens the bill. Omitted for roles that cannot bill - a WAITER, most of
   * all, whose whole distinction from a cashier is that they do not.
   */
  readonly onBill?: (table: FloorTable) => void;
  /** Opens the table editor. Only for roles that configure the floor. */
  readonly onEdit?: (table: FloorTable) => void;
}

/**
 * One table on the board.
 *
 * Now the entry point into the POS: one tap opens the order for this table -
 * the existing one if there is one, an empty screen if not. It renders as a
 * plain card rather than a button when the signed-in role cannot take orders,
 * because a control that looks pressable and refuses is worse than none.
 *
 * Tapping does NOT create an order. The screen it opens writes nothing until a
 * real dish is added, so a mis-tap costs nothing and leaves no history.
 *
 * Sized for a glance across a room, not for a mouse: the name is large, the
 * status is stated in words as well as colour, and the whole card is tinted so
 * a busy table is visible in peripheral vision.
 */
export function TableCard({ table, areaName, onOpen, onBill, onEdit }: TableCardProps): JSX.Element {
  const presentation = TABLE_STATUS_PRESENTATION[table.status];
  const interactive = onOpen !== undefined && table.isActive;

  /*
   * Bill is offered only on a table that has something to bill.
   *
   * AVAILABLE means no order exists, so the button would resolve to "nothing
   * on this table" - a dead end dressed as an action. The other four statuses
   * all imply a live order, and AWAITING_PAYMENT is the one this exists for:
   * the customer is standing at the counter saying a table number.
   */
  const billable = onBill !== undefined && table.isActive && table.status !== 'AVAILABLE';
  const awaitingPayment = table.status === 'AWAITING_PAYMENT';

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[17px] font-extrabold tracking-tight">{table.name}</h3>
          {areaName !== undefined && (
            <p className="text-muted-2 truncate text-[11.5px] font-semibold">{areaName}</p>
          )}
        </div>
        <span className="text-muted-2 shrink-0 font-mono text-[11px] font-semibold">
          {table.capacity} seats
        </span>
      </div>

      <div className="mt-auto pt-3">
        <TableStatusBadge status={table.status} />
        <p className="text-muted-2 mt-1 text-[11.5px] leading-snug">
          {table.isActive ? presentation.action : 'Out of service'}
        </p>
      </div>
    </>
  );

  const shell = cn(
    'flex min-h-[132px] w-full flex-col rounded-card border p-4 text-left transition-colors',
    presentation.card,
    !table.isActive && 'opacity-55',
  );
  const label = `${table.name}, ${presentation.label.toLowerCase()}, seats ${String(table.capacity)}`;

  /*
   * The Bill strip is a SIBLING of the card, never nested inside it.
   *
   * The interactive card is a <button>, and a button inside a button is
   * invalid HTML that browsers resolve by dropping one of them - usually the
   * inner one, silently, so the bill click would land on "open order" instead.
   * Wrapping both in a plain div keeps two real, separate controls.
   */
  const billStrip = billable ? (
    <button
      type="button"
      aria-label={`${label}. Open the bill.`}
      onClick={() => {
        onBill(table);
      }}
      className={cn(
        'w-full rounded-xl border px-3 py-2 text-[12.5px] font-bold transition-colors',
        'focus-visible:ring-accent-hover/50 outline-none focus-visible:ring-2',
        awaitingPayment
          ? // The bill is already issued and money is owed. This is the most
            // urgent thing on the floor, so it is the loudest control on it.
            'border-status-payment bg-status-payment text-white'
          : 'border-border-3 hover:border-accent text-muted hover:text-accent',
      )}
    >
      {awaitingPayment ? 'Take payment →' : 'Bill'}
    </button>
  ) : null;

  const editButton =
    onEdit === undefined ? null : (
      <button
        type="button"
        aria-label={`Edit ${table.name}`}
        title="Edit table"
        onClick={() => {
          onEdit(table);
        }}
        className={cn(
          'border-border-3 text-muted hover:border-accent hover:text-accent grid shrink-0 place-items-center rounded-xl border px-2.5 py-2 transition-colors',
          'focus-visible:ring-accent-hover/50 outline-none focus-visible:ring-2',
          billStrip === null && 'flex w-full items-center justify-center gap-1.5 text-[12.5px] font-bold',
        )}
      >
        <Pencil size={14} aria-hidden />
        {billStrip === null && 'Edit'}
      </button>
    );
  const actions =
    billStrip === null && editButton === null ? null : (
      <div className="mt-1.5 flex gap-1.5">
        {billStrip}
        {editButton}
      </div>
    );

  if (!interactive) {
    return (
      <div>
        <article aria-label={label} className={shell}>
          {body}
        </article>
        {actions}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-label={`${label}. Open order.`}
        onClick={() => {
          onOpen(table);
        }}
        className={cn(
          shell,
          'hover:border-accent cursor-pointer',
          'focus-visible:ring-accent-hover/50 outline-none focus-visible:ring-2',
        )}
      >
        {body}
      </button>
      {actions}
    </div>
  );
}
