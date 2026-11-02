import { kitchenProgressLabel } from '@nayaro/shared';
import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import type { OrderDto, OrderItemDto, OrderKitchenState, OrderTicketDto } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { CorrectionDialog } from '@/features/corrections/components/CorrectionDialog';
import { useCorrections, useMayCorrect } from '@/features/corrections/hooks/useCorrections';
import type { OrderEditor } from '../hooks/useOrder';
import { NoteEditor } from './NoteEditor';

export interface OrderPanelProps {
  readonly order: OrderDto | null;
  /** "Table 4" or "Takeaway" - shown before an order id exists. */
  readonly heading: string;
  readonly editor: OrderEditor;
}

/**
 * The right-hand half of the POS: the order as it stands.
 *
 * Persistent and sticky, because it is the cashier's running confirmation of
 * every tap. It renders before an Order row exists - the empty state is a real
 * state here, not a loading placeholder, and saying so is what makes "clicking
 * a table writes nothing to the database" visible rather than merely true.
 */
export function OrderPanel({ order, heading, editor }: OrderPanelProps): JSX.Element {
  const navigate = useNavigate();
  const corrections = useCorrections();
  const mayCorrect = useMayCorrect();
  // Once an order is BILLED, PAID or VOID it is a record, not a working
  // document. Disabling here is not the safeguard - the server refuses either
  // way - but a control that looks live and then errors teaches distrust.
  const readOnly = order !== null && order.status !== 'DRAFT' && order.status !== 'OPEN';

  return (
    <aside id="order-panel" className="w-full shrink-0 scroll-mt-20 md:sticky md:top-6 md:w-[320px] lg:w-[380px] xl:w-[420px]">
      <div className="border-border-2 bg-surface flex md:max-h-[calc(100dvh-8.5rem)] flex-col overflow-hidden rounded-card border">
        <header className="border-border bg-surface-2 border-b px-5 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="truncate text-[17px] font-extrabold tracking-tight">{heading}</h2>
            {order !== null && (
              <span className="text-muted-2 shrink-0 font-mono text-[11.5px] font-semibold">
                Order #{order.orderNumber}
              </span>
            )}
          </div>
          <p className="text-muted mt-0.5 text-[12px] font-semibold">
            {order === null
              ? 'Not started'
              : order.status === 'DRAFT'
                ? 'Draft — nothing sent to the kitchen yet'
                : order.status === 'OPEN'
                  ? 'Open — the kitchen has this order'
                  : order.status === 'BILLED'
                    ? 'Billed — waiting for payment'
                    : order.status === 'PAID'
                      ? 'Paid — this order is closed'
                      : 'Cancelled'}
          </p>
          {order !== null && <KitchenLine kitchen={order.kitchen} />}
        </header>

        {editor.notice !== null && (
          <p
            role="status"
            className="border-warn/40 bg-warn/10 text-warn-fg m-4 mb-0 rounded-xl border px-3.5 py-2.5 text-[12.5px] font-semibold"
          >
            {editor.notice}
            <button
              type="button"
              onClick={editor.dismissNotice}
              className="ml-2 underline underline-offset-2"
            >
              Dismiss
            </button>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {order === null || order.items.length === 0 ? (
            <p className="text-muted-2 py-8 text-center text-[13.5px]">
              Add an item to start this order.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {order.items.map((item) => (
                <OrderLine
                  key={item.id}
                  item={item}
                  order={order}
                  editor={editor}
                  readOnly={readOnly}
                  corrections={corrections}
                  mayCorrect={mayCorrect}
                />
              ))}
            </ul>
          )}

          {order !== null && (order.tableTransfers ?? []).length > 0 && (
            <section className="border-border-2 mb-4 border-t pt-3" aria-label="Table moves">
              <h3 className="text-muted mb-2 text-xs font-bold">Table moves</h3>
              <ul className="text-muted space-y-2 text-xs">
                {(order.tableTransfers ?? []).map((move) => (
                  <li key={move.id}>
                    <span className="text-text font-semibold">
                      {move.from.name} → {move.to.name}
                    </span>
                    <br />
                    {move.staff.name} · {new Date(move.at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {order !== null && order.tickets.length > 0 && (
            <TicketHistory
              order={order}
              corrections={corrections}
              mayCorrect={mayCorrect && !readOnly}
            />
          )}
        </div>

        <footer className="border-border bg-surface-2 border-t px-5 py-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[13.5px] font-bold">Subtotal</span>
            <span className="font-mono text-[19px] font-extrabold tracking-tight">
              {formatPaisa(order?.subtotalPaisa ?? 0)}
            </span>
          </div>
          {/*
           * VAT, service charge, discount and rounding are deliberately absent.
           * They belong to the invoice, are calculated once at billing time and
           * frozen there; a preview here would be a second implementation of
           * the same arithmetic, and the two would eventually disagree.
           */}
          <p className="text-muted-2 mt-1 text-[11.5px]">
            Taxes and charges are calculated when the bill is made.
          </p>

          <SendButton order={order} editor={editor} />

          {/*
           * Billing opens only once the order is OPEN. A DRAFT has never been
           * to the kitchen, and the server refuses to bill one - offering the
           * button anyway would be offering a dead end.
           */}
          {order !== null && (order.status === 'OPEN' || order.status === 'BILLED') && (
            <Button
              variant="secondary"
              size="lg"
              className="mt-2 w-full"
              onClick={() => void navigate(`/billing/${order.id}`)}
            >
              Generate Bill
            </Button>
          )}
        </footer>
      </div>
    </aside>
  );
}

function OrderLine({
  item,
  order,
  editor,
  readOnly,
  corrections,
  mayCorrect,
}: {
  item: OrderItemDto;
  order: OrderDto;
  editor: OrderEditor;
  readOnly: boolean;
  corrections: ReturnType<typeof useCorrections>;
  mayCorrect: boolean;
}): JSX.Element {
  const [editingNote, setEditingNote] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // How much of this line the kitchen still holds on the customer's behalf.
  // Undispatched units are an ordinary edit, not a cancellation.
  const cancellable = item.dispatchedQuantity - item.cancelledQuantity;
  const [cancelQuantity, setCancelQuantity] = useState(1);

  return (
    <li className="border-border/70 border-b py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] leading-tight font-bold">{item.name}</p>
          {(item.components?.length ?? 0) > 0 && (
            <span className="text-muted-2 block text-xs">
              {item.components!.map((part) => `${part.quantity} × ${part.name}`).join(', ')}
            </span>
          )}
          {item.promotion && (
            <span className="text-accent block text-xs">
              {item.promotion.name} · {item.promotion.rateBp / 100}% off{' '}
              <del className="text-muted-2">
                {formatPaisa(item.promotion.regularUnitPricePaisa)}
              </del>
            </span>
          )}
          {item.nameNp !== null && (
            <p className="text-muted-2 truncate text-[11.5px] leading-tight">{item.nameNp}</p>
          )}
          <p className="text-muted-2 mt-0.5 font-mono text-[11px]">
            {formatPaisa(item.unitPricePaisa)} each
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <StepButton
            label={`Remove one ${item.name}`}
            disabled={readOnly || editor.isSaving || item.quantity <= item.dispatchedQuantity}
            title={
              readOnly
                ? 'This order is closed'
                : item.quantity <= item.dispatchedQuantity && item.dispatchedQuantity > 0
                  ? 'Already sent to kitchen'
                  : undefined
            }
            onClick={() => void editor.setQuantity(item.id, item.quantity - 1)}
          >
            −
          </StepButton>
          <span className="w-7 text-center font-mono text-[14px] font-bold">{item.quantity}</span>
          <StepButton
            label={`Add one ${item.name}`}
            disabled={readOnly || editor.isSaving}
            {...(readOnly ? { title: 'This order is closed' } : {})}
            onClick={() => void editor.setQuantity(item.id, item.quantity + 1)}
          >
            +
          </StepButton>
        </div>

        <span className="w-[86px] shrink-0 text-right font-mono text-[13.5px] font-bold">
          {formatPaisa(item.lineTotalPaisa)}
          {item.cancelledQuantity > 0 && (
            <span className="text-muted-2 block text-[11px] font-semibold">
              Billing {item.billableQuantity} of {item.quantity}
            </span>
          )}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <DispatchState item={item} />
        {item.note !== null && (
          <span className="bg-accent/10 text-accent-hover rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold">
            {item.note}
          </span>
        )}
        <button
          type="button"
          disabled={readOnly}
          onClick={() => {
            setEditingNote((open) => !open);
          }}
          className="text-muted-2 hover:text-accent-hover text-[11.5px] font-semibold"
        >
          {item.note === null ? 'Add note' : 'Edit note'}
        </button>
        {mayCorrect && !readOnly && cancellable > 0 ? (
          <button
            type="button"
            disabled={corrections.isSaving}
            onClick={() => {
              setCancelQuantity(1);
              setCancelling(true);
            }}
            className="text-muted-2 hover:text-danger ml-auto text-[11.5px] font-semibold disabled:opacity-50"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            disabled={readOnly || editor.isSaving || item.dispatchedQuantity > 0}
            title={
              readOnly
                ? 'This order is closed'
                : item.dispatchedQuantity > 0
                  ? 'Already sent to kitchen'
                  : undefined
            }
            onClick={() => void editor.removeItem(item.id)}
            className="text-muted-2 hover:text-danger ml-auto text-[11.5px] font-semibold disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>

      {item.cancellations.map((cancellation) => (
        <p key={cancellation.id} className="text-danger mt-1 text-[11.5px] font-semibold">
          Cancelled {cancellation.quantity} — {cancellation.reason}
          <span className="text-muted-2 font-normal"> ({cancellation.cancelledBy.name})</span>
        </p>
      ))}

      {cancelling && (
        <CorrectionDialog
          open
          title={`Cancel ${item.name}?`}
          consequence={`${String(cancelQuantity)} of ${String(item.dispatchedQuantity)} will stay in the kitchen's record but will not be billed. The customer will be charged for ${String(Math.max(0, item.billableQuantity - cancelQuantity))}.`}
          confirmLabel="Cancel the item"
          busy={corrections.isSaving}
          error={corrections.error}
          onClose={() => {
            setCancelling(false);
            corrections.clearError();
          }}
          onConfirm={(reason) => {
            void corrections.cancelItem(order.id, item.id, cancelQuantity, reason).then((ok) => {
              if (ok) setCancelling(false);
            });
          }}
        >
          {cancellable > 1 && (
            <label className="mt-3 block">
              <span className="text-muted mb-1.5 block text-[12.5px] font-semibold">How many</span>
              <select
                aria-label="How many to cancel"
                value={cancelQuantity}
                onChange={(event) => {
                  setCancelQuantity(Number(event.target.value));
                }}
                className="bg-field text-text border-border-2 rounded-xl border px-3 py-2 text-[14px]"
              >
                {Array.from({ length: cancellable }, (_, index) => index + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </CorrectionDialog>
      )}

      {editingNote && (
        <NoteEditor
          value={item.note}
          busy={editor.isSaving}
          onCancel={() => {
            setEditingNote(false);
          }}
          onSave={(note) => {
            setEditingNote(false);
            void editor.setNote(item.id, note);
          }}
        />
      )}
    </li>
  );
}

/**
 * One line of kitchen context, from counts the server already computed.
 *
 * Deliberately NOT a second kitchen board. A cashier asked "is table 6's food
 * up?" needs a number, not a ticket list - and the Kitchen screen is one click
 * away for anyone who needs more. Silent when there is nothing to report.
 */
function KitchenLine({ kitchen }: { kitchen: OrderKitchenState }): JSX.Element | null {
  if (kitchen.ticketCount === 0) return null;

  const parts: string[] = [];
  if (kitchen.newCount > 0) parts.push(`${String(kitchen.newCount)} waiting`);
  if (kitchen.preparingCount > 0) parts.push(`${String(kitchen.preparingCount)} preparing`);
  if (kitchen.readyCount > 0) parts.push(`${String(kitchen.readyCount)} ready`);
  if (kitchen.servedCount > 0) parts.push(`${String(kitchen.servedCount)} served`);

  return (
    <p className="text-muted-2 mt-1 text-[11.5px] font-semibold">
      <span className="text-muted">Kitchen</span> {parts.join(' · ')}
    </p>
  );
}

/**
 * The send control, and the three things it has to say.
 *
 *   "Send to Kitchen"  there is something to send
 *   "Sending…"         in flight
 *   "Everything sent"  nothing undispatched, so nothing to do
 *
 * Disabling it is a courtesy, not a safeguard. A double-click, a stuck key or
 * a second terminal is settled by the server: the version claim means the
 * second request loses, and NOTHING_TO_SEND means an empty ticket is never
 * written. The button only saves the user from finding that out.
 */
function SendButton({
  order,
  editor,
}: {
  order: OrderDto | null;
  editor: OrderEditor;
}): JSX.Element {
  const pending = order?.items.reduce((total, item) => total + item.undispatchedQuantity, 0) ?? 0;
  const hasSentSomething = (order?.items ?? []).some((item) => item.dispatchedQuantity > 0);

  const label = editor.isSaving
    ? 'Sending…'
    : pending > 0
      ? 'Send to Kitchen'
      : hasSentSomething
        ? 'Everything sent'
        : 'Send to Kitchen';

  return (
    <>
      <Button
        size="lg"
        className="mt-4 w-full"
        loading={editor.isSaving}
        disabled={pending === 0 || editor.isSaving}
        onClick={() => void editor.sendToKitchen()}
      >
        {label}
      </Button>
      {pending > 0 && !editor.isSaving && (
        <p className="text-muted-2 mt-2 text-center text-[11.5px]">
          {pending} {pending === 1 ? 'item' : 'items'} waiting to go
        </p>
      )}
      {pending === 0 && hasSentSomething && (
        <p className="text-muted-2 mt-2 text-center text-[11.5px]">
          Add something to send another ticket.
        </p>
      )}
    </>
  );
}

/**
 * The sent/unsent split, shown only when it tells the cashier something.
 *
 * A line that has never been sent says nothing at all - that is the ordinary
 * case and does not need a label. A fully sent line says a quiet "Sent". Only
 * a partly-sent line spells out both numbers, because that is the one state
 * where the difference matters and where the minus button is about to refuse.
 */
function DispatchState({ item }: { item: OrderItemDto }): JSX.Element | null {
  if (item.dispatchedQuantity === 0) return null;

  if (item.undispatchedQuantity === 0) {
    return <span className="text-muted-3 text-[11.5px] font-semibold">Sent</span>;
  }

  return (
    <span className="text-accent-hover text-[11.5px] font-bold">
      Sent {item.dispatchedQuantity} · To send {item.undispatchedQuantity}
    </span>
  );
}

function StepButton({
  children,
  label,
  disabled,
  title,
  onClick,
}: {
  children: string;
  label: string;
  disabled: boolean;
  title?: string | undefined;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      {...(title === undefined ? {} : { title })}
      onClick={onClick}
      className={cn(
        'border-border-2 bg-surface grid size-8 place-items-center rounded-lg border text-[15px] font-bold',
        'hover:border-accent-hover hover:text-accent-hover transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Every ticket this order has produced, voided ones included.
 *
 * WHY THIS LIVES ON THE POS rather than on the kitchen board. Voiding a ticket
 * is a manager saying "we should never have sent that", and the manager is
 * standing at the till looking at the order, not at the kitchen screen. It is
 * also where the consequence is visible: the quantities come straight back
 * into "to send", and the resend is the next button along. The kitchen board
 * deliberately shows no voided tickets at all - a cook must not act on one.
 *
 * The record stays. A voided ticket keeps its number, its reason, and the name
 * of whoever voided it, because "why did the kitchen make two of these?" is a
 * question somebody asks the next morning.
 */
function TicketHistory({
  order,
  corrections,
  mayCorrect,
}: {
  order: OrderDto;
  corrections: ReturnType<typeof useCorrections>;
  mayCorrect: boolean;
}): JSX.Element {
  const [voiding, setVoiding] = useState<OrderTicketDto | null>(null);

  return (
    <section className="border-border mt-4 border-t pt-3">
      <h3 className="text-muted mb-2 font-mono text-[10.5px] font-bold tracking-widest uppercase">
        Kitchen tickets
      </h3>
      <ul className="flex flex-col gap-1.5">
        {order.tickets.map((ticket) => (
          <li key={ticket.id} className="flex items-start gap-2">
            <span
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold',
                ticket.status === 'VOID' ? 'bg-danger/10 text-danger' : 'bg-surface-3 text-muted',
              )}
            >
              #{ticket.kotNumber}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold">
                {ticket.items.map((line) => `${line.name} x${String(line.quantity)}`).join(', ')}
              </p>
              {ticket.status === 'VOID' ? (
                <p className="text-danger text-[11.5px] font-semibold">
                  Voided — {ticket.voidReason}
                  <span className="text-muted-2 font-normal"> ({ticket.voidedBy?.name})</span>
                </p>
              ) : (
                <p className="text-muted-2 text-[11.5px] font-semibold">
                  {kitchenProgressLabel(ticket.status)}
                </p>
              )}
            </div>
            {/*
             * SERVED tickets carry no Void button, matching the server: the
             * food has left the kitchen, so the dispatch is a fact. Correcting
             * the bill from there is a cancellation on the line above.
             */}
            {mayCorrect && ticket.status !== 'VOID' && ticket.status !== 'SERVED' && (
              <button
                type="button"
                disabled={corrections.isSaving}
                onClick={() => {
                  setVoiding(ticket);
                }}
                className="text-muted-2 hover:text-danger shrink-0 text-[11.5px] font-semibold disabled:opacity-50"
              >
                Void
              </button>
            )}
          </li>
        ))}
      </ul>

      <CorrectionDialog
        open={voiding !== null}
        title={voiding === null ? 'Void ticket' : `Void KOT #${String(voiding.kotNumber)}?`}
        consequence={
          voiding === null
            ? ''
            : voiding.status === 'NEW'
              ? 'The kitchen has not started this yet. Its quantities will become available to send again.'
              : voiding.status === 'PREPARING'
                ? 'The kitchen is already cooking this. Tell them before you void it — the quantities will become available to send again.'
                : 'This food is already cooked and waiting to go out. Voiding says it was never meant to be sent, and its quantities will become available to send again. Tell the kitchen first.'
        }
        confirmLabel="Void the ticket"
        busy={corrections.isSaving}
        error={corrections.error}
        onClose={() => {
          setVoiding(null);
          corrections.clearError();
        }}
        onConfirm={(reason) => {
          if (voiding === null) return;
          void corrections.voidKot(voiding.id, reason).then((ok) => {
            if (ok) setVoiding(null);
          });
        }}
      />
    </section>
  );
}
