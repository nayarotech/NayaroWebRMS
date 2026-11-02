import { useState, type JSX } from 'react';
import type { CashMovementType, PaymentMethod, ShiftDto } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import { cn } from '@/lib/utils';
import { formatPaisa, parseRupees } from '@/lib/money';
import { ApiRequestError } from '@/services/apiClient';
import { useCurrentShift, useDrawerActions } from '@/features/drawer/hooks/useDrawer';
import { Page, PageHeader } from '@/components/layout/Page';

/**
 * The cash drawer.
 *
 * Opened with a float at the start of service, closed with a count at the end.
 * In between, cash sales arrive on their own - any cash payment taken while
 * the drawer is open belongs to it - and petty cash is recorded as pay-outs
 * with a reason.
 *
 * Nothing on this screen edits or deletes. A wrong pay-out is fixed with a
 * pay-in that says so, and a count, once entered, is the count.
 */
const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  QR: 'QR',
  CARD: 'Card',
  CREDIT: 'Credit',
};

export function DrawerScreen(): JSX.Element {
  const current = useCurrentShift();
  const actions = useDrawerActions();
  const [moving, setMoving] = useState<CashMovementType | null>(null);
  const [closing, setClosing] = useState(false);
  const [justClosed, setJustClosed] = useState<ShiftDto | null>(null);

  if (current.isPending) return <p className="text-muted text-sm">Checking the drawer…</p>;

  if (current.isError && current.data === undefined) {
    const forbidden = current.error instanceof ApiRequestError && current.error.status === 403;
    return (
      <Notice
        title={forbidden ? 'The cash drawer is not part of your role' : 'Could not load the drawer'}
        body={
          forbidden
            ? 'A cashier, manager or owner handles the drawer.'
            : 'Nayaro RMS could not be reached. Check your internet connection.'
        }
      />
    );
  }

  const shift = current.data.shift;

  return (
    <Page>
      <PageHeader
        title="Cash drawer"
        description={
          <>
            {shift === null
              ? 'The drawer is closed. Open it with the cash you are starting with.'
              : `Open since ${new Date(shift.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, opened by ${shift.openedBy.name}.`}
          </>
        }
      />

      {actions.error !== null && (
        <p
          role="alert"
          className="border-danger/40 bg-danger/8 text-danger-fg mb-4 rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold"
        >
          {actions.error}
          <button
            type="button"
            onClick={actions.clearError}
            className="ml-2 underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      )}

      {justClosed?.close != null && (
        <ClosedSummary
          shift={justClosed}
          onDismiss={() => {
            setJustClosed(null);
          }}
        />
      )}

      {shift === null ? (
        <OpenDrawerForm busy={actions.isSaving} onOpen={(paisa) => void actions.open(paisa)} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Stat label="Opening float" value={formatPaisa(shift.openingFloatPaisa)} />
            <Stat label="Cash sales" value={formatPaisa(shift.cashSalesPaisa)} sign="+" />
            <Stat
              label="Credit collections (net)"
              value={formatPaisa(shift.cashCreditCollectionsPaisa)}
            />
            <Stat label="Paid in" value={formatPaisa(shift.payInsPaisa)} sign="+" />
            <Stat label="Paid out" value={formatPaisa(shift.payOutsPaisa)} sign="−" />
            <Stat label="Should be in drawer" value={formatPaisa(shift.expectedCashPaisa)} strong />
          </div>

          <div className="mb-6 flex flex-wrap gap-2.5">
            <Button
              variant="secondary"
              onClick={() => {
                setMoving('PAY_IN');
              }}
            >
              Pay in
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setMoving('PAY_OUT');
              }}
            >
              Pay out
            </Button>
            <Button
              className="ml-auto"
              onClick={() => {
                setClosing(true);
              }}
            >
              Count &amp; close drawer
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
            <section className="border-border bg-surface shadow-card rounded-card border">
              <h2 className="border-border text-muted border-b px-4 py-2.5 font-mono text-[10.5px] font-semibold tracking-widest uppercase">
                Takings this shift
              </h2>
              {shift.takings.length === 0 ? (
                <p className="text-muted px-4 py-6 text-[13.5px]">No payments yet.</p>
              ) : (
                <ul>
                  {shift.takings.map((t) => (
                    <li
                      key={t.method}
                      className="border-border/70 flex items-baseline border-b px-4 py-2.5 text-[13.5px] last:border-b-0"
                    >
                      <span className="font-semibold">{METHOD_LABEL[t.method]}</span>
                      <span className="text-muted-2 ml-2 text-[12px]">
                        {t.count} {t.count === 1 ? 'payment' : 'payments'}
                      </span>
                      <span className="ml-auto font-mono font-bold">
                        {formatPaisa(t.amountPaisa)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-muted-2 px-4 pb-3 text-[11.5px]">
                Only cash goes in the drawer. QR, card and credit are shown for reference.
              </p>
            </section>

            <section className="border-border bg-surface shadow-card rounded-card border">
              <h2 className="border-border text-muted border-b px-4 py-2.5 font-mono text-[10.5px] font-semibold tracking-widest uppercase">
                Pay-ins &amp; pay-outs
              </h2>
              {shift.movements.length === 0 ? (
                <p className="text-muted px-4 py-6 text-[13.5px]">None this shift.</p>
              ) : (
                <ul>
                  {shift.movements.map((m) => (
                    <li
                      key={m.id}
                      className="border-border/70 flex items-baseline gap-3 border-b px-4 py-2.5 text-[13.5px] last:border-b-0"
                    >
                      <span className="text-muted-2 w-12 shrink-0 text-[12px]">
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="min-w-0 flex-1">
                        {m.reason}
                        <span className="text-muted-2 block text-[11px]">{m.staff.name}</span>
                      </span>
                      <span
                        className={cn(
                          'font-mono font-bold whitespace-nowrap',
                          m.type === 'PAY_IN' ? 'text-ok-fg' : 'text-danger-fg',
                        )}
                      >
                        {m.type === 'PAY_IN' ? '+' : '−'} {formatPaisa(m.amountPaisa)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <MovementDialog
            type={moving}
            busy={actions.isSaving}
            onClose={() => {
              setMoving(null);
            }}
            onSave={(amountPaisa, reason) => {
              if (moving === null) return;
              void actions.move(shift.id, { type: moving, amountPaisa, reason }).then((saved) => {
                if (saved !== null) setMoving(null);
              });
            }}
          />

          <CloseDialog
            open={closing}
            shift={shift}
            busy={actions.isSaving}
            onClose={() => {
              setClosing(false);
            }}
            onConfirm={(countedCashPaisa, note) => {
              void actions
                .close(shift.id, { countedCashPaisa, ...(note.length > 0 ? { note } : {}) })
                .then((closed) => {
                  if (closed === null) return;
                  setClosing(false);
                  setJustClosed(closed);
                });
            }}
          />
        </>
      )}
    </Page>
  );
}

function OpenDrawerForm({
  busy,
  onOpen,
}: {
  busy: boolean;
  onOpen: (openingFloatPaisa: number) => void;
}): JSX.Element {
  const [float, setFloat] = useState('');
  const paisa = parseRupees(float);
  return (
    <form
      className="border-border-2 bg-surface max-w-md rounded-card border px-6 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (paisa !== null) onOpen(paisa);
      }}
    >
      <TextField
        label="Opening float (₨)"
        hint="Count the change in the drawer before the first sale. Enter 0 if it is empty."
        inputMode="decimal"
        value={float}
        autoFocus
        onChange={(event) => {
          setFloat(event.target.value);
        }}
        error={float.length > 0 && paisa === null ? 'Enter an amount in rupees.' : undefined}
      />
      <Button type="submit" disabled={paisa === null || busy}>
        Open drawer
      </Button>
    </form>
  );
}

function MovementDialog({
  type,
  busy,
  onClose,
  onSave,
}: {
  type: CashMovementType | null;
  busy: boolean;
  onClose: () => void;
  onSave: (amountPaisa: number, reason: string) => void;
}): JSX.Element {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const paisa = parseRupees(amount);
  const valid = paisa !== null && paisa > 0 && reason.trim().length >= 3;
  const isOut = type === 'PAY_OUT';

  const close = (): void => {
    setAmount('');
    setReason('');
    onClose();
  };

  return (
    <Modal
      open={type !== null}
      title={isOut ? 'Pay out of the drawer' : 'Pay into the drawer'}
      description={
        isOut
          ? 'Cash taken out for something other than a refund — vegetables, gas, a delivery.'
          : 'Cash put in that is not a sale — more change, or the owner topping up.'
      }
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() => {
              if (valid) onSave(paisa, reason.trim());
            }}
          >
            {isOut ? 'Record pay-out' : 'Record pay-in'}
          </Button>
        </>
      }
    >
      <TextField
        label="Amount (₨)"
        inputMode="decimal"
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
        }}
      />
      <TextField
        label="Reason"
        hint="This is the only record of why the cash moved."
        value={reason}
        maxLength={300}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
    </Modal>
  );
}

function CloseDialog({
  open,
  shift,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  shift: ShiftDto;
  busy: boolean;
  onClose: () => void;
  onConfirm: (countedCashPaisa: number, note: string) => void;
}): JSX.Element {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const paisa = parseRupees(counted);

  return (
    <Modal
      open={open}
      title="Count and close the drawer"
      description="Count every note and coin in the drawer, including the float. Once closed, the count cannot be changed."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={paisa === null || busy}
            onClick={() => {
              if (paisa !== null) onConfirm(paisa, note.trim());
            }}
          >
            Close drawer
          </Button>
        </>
      }
    >
      <TextField
        label="Cash counted (₨)"
        inputMode="decimal"
        value={counted}
        autoFocus
        onChange={(event) => {
          setCounted(event.target.value);
        }}
      />
      {paisa !== null && (
        <p className="text-muted -mt-2 mb-4 text-[12.5px]">
          The drawer should hold {formatPaisa(shift.expectedCashPaisa)}.{' '}
          <VarianceText variancePaisa={paisa - shift.expectedCashPaisa} />
        </p>
      )}
      <TextField
        label="Note (optional)"
        hint="If the count is off, say what you know."
        value={note}
        maxLength={300}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
    </Modal>
  );
}

function ClosedSummary({
  shift,
  onDismiss,
}: {
  shift: ShiftDto;
  onDismiss: () => void;
}): JSX.Element {
  const close = shift.close!;
  return (
    <div className="border-border-2 bg-surface mb-5 rounded-card border px-5 py-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-[16px] font-extrabold">Drawer closed</h2>
          <p className="text-muted mt-1 text-[13.5px]">
            Expected {formatPaisa(close.expectedCashPaisa)}, counted{' '}
            {formatPaisa(close.countedCashPaisa)}.{' '}
            <VarianceText variancePaisa={close.variancePaisa} />
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted ml-auto text-[12.5px] font-semibold underline-offset-2 hover:underline"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function VarianceText({ variancePaisa }: { variancePaisa: number }): JSX.Element {
  if (variancePaisa === 0)
    return <span className="text-ok-fg font-bold">The drawer balances.</span>;
  return (
    <span className={cn('font-bold', variancePaisa < 0 ? 'text-danger-fg' : 'text-warn-fg')}>
      {variancePaisa < 0 ? 'Short' : 'Over'} by {formatPaisa(Math.abs(variancePaisa))}.
    </span>
  );
}

function Stat({
  label,
  value,
  sign,
  strong = false,
}: {
  label: string;
  value: string;
  sign?: '+' | '−';
  strong?: boolean;
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-card border px-4 py-3',
        strong ? 'border-accent/40 bg-accent/6' : 'border-border-2 bg-surface',
      )}
    >
      <p className="text-muted font-mono text-[10.5px] font-semibold tracking-widest uppercase">
        {label}
      </p>
      <p className="mt-1 font-mono text-[17px] font-extrabold tracking-tight">
        {sign !== undefined && <span className="text-muted-2 mr-0.5">{sign}</span>}
        {value}
      </p>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <Page>
      <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
        <h2 className="text-[18px] font-extrabold tracking-tight">{title}</h2>
        <p className="text-muted mt-2 text-[14px]">{body}</p>
      </div>
    </Page>
  );
}
