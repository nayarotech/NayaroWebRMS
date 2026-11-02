import { useState, type JSX } from 'react';
import {
  canSplitByItem,
  itemPaymentShares,
  selectedItemAmount,
  type InvoiceDto,
  type PaymentMethod,
  type PaymentItemSelection,
} from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { CustomerEditor } from '@/features/credit/CustomerEditor';
import { useCreditActions, useCustomers } from '@/features/credit/useCredit';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';

export interface PaymentPanelProps {
  readonly invoice: InvoiceDto;
  readonly busy: boolean;
  readonly onPay: (input: {
    method: PaymentMethod;
    amountPaisa: number;
    items?: readonly PaymentItemSelection[];
    tenderedPaisa?: number;
    reference?: string;
    customerId?: string;
    creditAccountName?: string;
  }) => void;
  readonly onSettleZero: () => void;
}

/**
 * Taking money.
 *
 * The amount applied defaults to whatever is still owed, because that is what
 * happens ninety-nine times in a hundred and a cashier should not have to type
 * it. Cash is the exception worth designing for: the customer hands over a
 * round note, so the second field is what they GAVE, and the change is worked
 * out and shown large - that number is the one the cashier has to get right
 * while counting out coins.
 *
 * What this component never does is invent a payment. Every figure it submits
 * is checked again by the server, which owns the balance.
 *
 * The caller keys this on the invoice and order version, so a payment or
 * correction remounts it with fresh defaults. Resetting state by remounting is React's own answer
 * to "these inputs belong to a different amount now" - an effect that wrote
 * back into state would fight the user's typing on every refetch.
 */
const METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'QR', label: 'QR' },
  { value: 'CARD', label: 'Card' },
  { value: 'CREDIT', label: 'Credit' },
];

export function PaymentPanel({
  invoice,
  busy,
  onPay,
  onSettleZero,
}: PaymentPanelProps): JSX.Element {
  const remaining = invoice.settlement.remainingPaisa;
  const settled = remaining === 0;

  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amount, setAmount] = useState(() => rupees(remaining));
  const [splitMode, setSplitMode] = useState<'AMOUNT' | 'ITEMS'>(() =>
    canSplitByItem(invoice) && invoice.settlement.payments.some((payment) => payment.void === null)
      ? 'ITEMS'
      : 'AMOUNT',
  );
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const shares = itemPaymentShares(invoice);
  const itemSplitAvailable = canSplitByItem(invoice);
  const items = shares.flatMap((share) => {
    const quantity = quantities[share.invoiceLineId] ?? 0;
    return quantity > 0 ? [{ invoiceLineId: share.invoiceLineId, quantity }] : [];
  });
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const customers = useCustomers('', method === 'CREDIT');
  const customerActions = useCreditActions();
  const selectedCustomer = customers.data?.customers.find(
    (row) => row.id === customerId && row.isActive,
  );
  const creditValid = method !== 'CREDIT' || (selectedCustomer !== undefined && !customers.isError);

  const amountPaisa =
    splitMode === 'ITEMS'
      ? shares.reduce(
          (sum, share) => sum + selectedItemAmount(share, quantities[share.invoiceLineId] ?? 0),
          0,
        )
      : toPaisa(amount);
  const tenderedPaisa = tendered.trim().length === 0 ? null : toPaisa(tendered);
  const amountValid = amountPaisa !== null && amountPaisa > 0 && amountPaisa <= remaining;
  const tenderValid =
    method !== 'CASH' ||
    tendered.trim().length === 0 ||
    (tenderedPaisa !== null && amountPaisa !== null && tenderedPaisa >= amountPaisa);
  const changePaisa =
    tenderedPaisa !== null && amountPaisa !== null ? tenderedPaisa - amountPaisa : 0;

  if (invoice.grandTotalPaisa === 0 && invoice.settlement.status === 'UNPAID') {
    return (
      <div>
        <p className="text-muted-2 mb-3 text-[12.5px]">
          No money is due. Close this bill to finish the sale.
        </p>
        <Button size="lg" className="w-full" loading={busy} disabled={busy} onClick={onSettleZero}>
          Close bill
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Totals invoice={invoice} />

      {invoice.settlement.payments.length > 0 && (
        <ul className="border-border/70 mt-3 flex flex-col gap-1 border-t pt-2.5">
          {invoice.settlement.payments.map((payment) => (
            <li
              key={payment.id}
              className={cn(
                'flex items-baseline justify-between gap-2',
                payment.void !== null && 'line-through opacity-60',
              )}
            >
              <span className="text-muted text-[12px] font-semibold">
                {METHODS.find((m) => m.value === payment.method)?.label ?? payment.method}
                {payment.void !== null && ' (reversed)'}
                {payment.itemAllocations.map((item) => (
                  <span key={item.invoiceLineId} className="block text-[11px]">
                    {item.quantity} ×{' '}
                    {invoice.lines.find((line) => line.id === item.invoiceLineId)?.description}
                  </span>
                ))}
                {payment.reference !== null && (
                  <span className="text-muted-2 ml-1.5 font-mono text-[11px]">
                    {payment.reference}
                  </span>
                )}
                {payment.creditAccountName !== null && (
                  <span className="text-muted-2 ml-1.5 text-[11px]">
                    {payment.creditAccountName}
                  </span>
                )}
              </span>
              <span className="font-mono text-[12.5px] font-semibold tabular-nums">
                {formatPaisa(payment.amountPaisa)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {settled ? (
        <p className="text-ok-fg mt-4 text-[13px] font-bold">This bill is fully settled.</p>
      ) : (
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !creditValid || !amountValid || !tenderValid || amountPaisa === null)
              return;
            onPay({
              method,
              amountPaisa,
              ...(splitMode === 'ITEMS' ? { items } : {}),
              ...(method === 'CASH' && tenderedPaisa !== null ? { tenderedPaisa } : {}),
              ...(reference.trim() && (method === 'QR' || method === 'CARD')
                ? { reference: reference.trim() }
                : {}),
              ...(method === 'CREDIT' ? { customerId } : {}),
            });
          }}
        >
          <fieldset disabled={busy} className="mb-4">
            <legend className="mb-2 text-sm font-bold">Split payment</legend>
            <div className="mb-2 flex gap-3 text-sm">
              <label>
                <input
                  type="radio"
                  name="split-mode"
                  checked={splitMode === 'AMOUNT'}
                  onChange={() => setSplitMode('AMOUNT')}
                />{' '}
                By amount
              </label>
              <label>
                <input
                  type="radio"
                  name="split-mode"
                  checked={splitMode === 'ITEMS'}
                  disabled={!itemSplitAvailable}
                  onChange={() => {
                    setSplitMode('ITEMS');
                    setTendered('');
                  }}
                />{' '}
                By item
              </label>
            </div>
            {!itemSplitAvailable && (
              <p className="text-muted mb-2 text-xs">
                An amount payment has been recorded. Continue by amount, or ask a manager to reverse
                it before choosing items.
              </p>
            )}
            {splitMode === 'ITEMS' ? (
              <>
                <p className="text-muted mb-2 text-xs">
                  Choose quantities for this guest. Prices include a proportional share of
                  discounts, charges and rounding.
                </p>
                {shares.map((share) => {
                  const line = invoice.lines.find((row) => row.id === share.invoiceLineId)!;
                  return (
                    <label
                      key={line.id}
                      className="mb-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <span>
                        {line.description}
                        <span className="text-muted block">
                          {share.remainingQuantity} left · {formatPaisa(share.remainingPaisa)}
                        </span>
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={share.remainingQuantity}
                        step={1}
                        aria-label={`Quantity to pay for ${line.description}`}
                        disabled={share.remainingQuantity === 0}
                        value={quantities[line.id] ?? 0}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setQuantities((current) => ({
                            ...current,
                            [line.id]: Number.isSafeInteger(value)
                              ? Math.max(0, Math.min(share.remainingQuantity, value))
                              : 0,
                          }));
                          setTendered('');
                        }}
                        className="bg-field border-border-3 w-16 rounded border px-2 py-1"
                      />
                    </label>
                  );
                })}
                <p className="mt-2 text-sm font-bold" aria-live="polite">
                  This payment: {formatPaisa(amountPaisa ?? 0)}
                </p>
              </>
            ) : (
              <p className="text-muted text-xs">
                Enter this guest’s share below. Record each payment separately; the table stays
                occupied until the balance is settled.
              </p>
            )}
          </fieldset>
          <p className="text-muted mb-2 font-mono text-[11px] font-semibold tracking-widest uppercase">
            Payment method
          </p>
          <div role="group" aria-label="Payment method" className="mb-3 grid grid-cols-4 gap-1.5">
            {METHODS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={method === option.value}
                disabled={busy}
                onClick={() => {
                  setMethod(option.value);
                }}
                className={cn(
                  'rounded-lg border px-2 py-2 text-[12.5px] font-bold transition-colors',
                  method === option.value
                    ? 'border-accent bg-accent text-white'
                    : 'border-border-2 bg-surface text-text-2 hover:border-accent-hover',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {splitMode === 'AMOUNT' && (
            <Field
              label="Amount"
              ariaLabel="Payment amount"
              value={amount}
              onChange={setAmount}
              invalid={!amountValid && amount.trim().length > 0}
            />
          )}

          {method === 'CASH' && (
            <>
              <Field
                label="Cash received"
                ariaLabel="Cash received"
                value={tendered}
                placeholder={rupees(amountPaisa ?? remaining)}
                onChange={setTendered}
                invalid={!tenderValid}
              />
              {tenderedPaisa !== null && tenderValid && (
                <div className="border-accent/40 bg-accent/8 mb-3 flex items-baseline justify-between rounded-lg border px-3 py-2">
                  <span className="text-[13px] font-bold">Change</span>
                  <span className="text-accent-hover font-mono text-[17px] font-extrabold tabular-nums">
                    {formatPaisa(changePaisa)}
                  </span>
                </div>
              )}
              {!tenderValid && (
                <p className="text-danger mb-2 text-[11.5px] font-semibold">
                  The cash received is less than the amount being paid.
                </p>
              )}
            </>
          )}

          {(method === 'QR' || method === 'CARD') && (
            <Field
              label={
                method === 'QR' ? 'Transaction reference (optional)' : 'Approval code (optional)'
              }
              ariaLabel="Payment reference"
              value={reference}
              onChange={setReference}
              mono
            />
          )}

          {method === 'CREDIT' && (
            <>
              <label
                className="text-muted mb-1 block text-xs font-semibold"
                htmlFor="credit-customer"
              >
                Customer account
              </label>
              <select
                id="credit-customer"
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
                disabled={busy || customers.isPending || customers.isError}
                required
                className="bg-field border-border-3 mb-2 w-full rounded-lg border px-2.5 py-2 text-sm"
              >
                <option value="">
                  {customers.isPending ? 'Loading accounts…' : 'Choose a customer'}
                </option>
                {customers.data?.customers
                  .filter((row) => row.isActive)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} · {row.phone || row.address || row.id.slice(-6)} · Owes{' '}
                      {formatPaisa(row.balancePaisa)}
                    </option>
                  ))}
              </select>
              {customers.isError && (
                <p role="alert" className="text-danger mb-2 text-xs">
                  Could not load accounts.{' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void customers.refetch()}
                  >
                    Refresh
                  </button>
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                className="text-accent-hover mb-3 text-xs font-semibold underline"
                onClick={() => {
                  customerActions.clearError();
                  setAddingCustomer(true);
                }}
              >
                Add customer
              </button>
              <p className="text-warn-fg bg-warn/10 border-warn/40 mb-3 rounded-lg border px-3 py-2 text-[11.5px] font-semibold">
                This amount remains owed by the customer. The table is freed only when the whole
                bill is settled, including credit.
              </p>
            </>
          )}

          {!amountValid && amount.trim().length > 0 && (
            <p className="text-danger mb-2 text-[11.5px] font-semibold">
              {amountPaisa !== null && amountPaisa > remaining
                ? 'That is more than the amount still owed.'
                : splitMode === 'ITEMS'
                  ? 'Choose items with an amount to pay.'
                  : 'Enter an amount to pay.'}
            </p>
          )}

          {/* Pinned to the bottom of the bill panel's scroll area: the one control
              the cashier must reach, whatever the window height. */}
          <div className="bg-surface-2 sticky bottom-0 -mx-5 -mb-4 px-5 pt-3 pb-4">
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={busy || !creditValid || !amountValid || !tenderValid}
            >
              {/*
               * "Confirm" for QR and card, because Nayaro RMS has not verified
               * anything with a payment provider - a cashier is telling the
               * system what they saw happen on another device.
               */}
              {method === 'CASH'
                ? amountPaisa === remaining
                  ? 'Complete Payment'
                  : 'Add Payment'
                : method === 'CREDIT'
                  ? 'Mark as Credit'
                  : `Confirm ${method === 'QR' ? 'QR' : 'Card'} Payment`}
            </Button>
            {amountValid && amountPaisa !== null && (
              <p className="text-muted mt-2 text-xs" aria-live="polite">
                After this payment: {formatPaisa(remaining - amountPaisa)} remaining.
              </p>
            )}
          </div>
        </form>
      )}
      {addingCustomer && (
        <CustomerEditor
          busy={customerActions.busy}
          error={customerActions.error}
          onClose={() => setAddingCustomer(false)}
          onSave={async (request) => {
            const created = await customerActions.create(request);
            if (created) setCustomerId(created.id);
            return created !== null;
          }}
        />
      )}
    </div>
  );
}

function Totals({ invoice }: { invoice: InvoiceDto }): JSX.Element {
  return (
    <dl className="flex flex-col gap-1.5">
      <Line label="Grand total" value={formatPaisa(invoice.grandTotalPaisa)} strong />
      <Line label="Paid" value={formatPaisa(invoice.settlement.totalPaidPaisa)} />
      <div className="border-border-2 mt-1 flex items-baseline justify-between border-t pt-2">
        <dt className="text-[14px] font-extrabold">Remaining</dt>
        <dd
          className={cn(
            'font-mono text-[20px] font-extrabold tracking-tight tabular-nums',
            invoice.settlement.remainingPaisa === 0 && 'text-ok-fg',
          )}
        >
          {formatPaisa(invoice.settlement.remainingPaisa)}
        </dd>
      </div>
    </dl>
  );
}

function Line({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn('text-[13px]', strong ? 'font-bold' : 'text-text-2 font-semibold')}>
        {label}
      </dt>
      <dd className="font-mono text-[13.5px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Field({
  label,
  ariaLabel,
  value,
  onChange,
  placeholder,
  invalid = false,
  mono = false,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  invalid?: boolean;
  mono?: boolean;
}): JSX.Element {
  return (
    <label className="mb-3 block">
      <span className="text-muted mb-1 block text-[11.5px] font-semibold">{label}</span>
      <input
        aria-label={ariaLabel}
        inputMode={mono ? 'text' : 'decimal'}
        value={value}
        {...(placeholder === undefined ? {} : { placeholder })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(
          'bg-field w-full rounded-lg border px-2.5 py-2 text-[14px] outline-none',
          mono && 'font-mono text-[13px]',
          invalid ? 'border-danger' : 'border-border-3 focus:border-accent-hover',
        )}
      />
    </label>
  );
}

/** Paisa -> the plain rupee string an input holds. No grouping while editing. */
function rupees(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

/** Rupee input -> integer paisa. Returns null for anything unparseable. */
function toPaisa(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  // Rounded, not truncated: a cashier typing 84.5 means 84.50, and floating
  // point makes 84.5 * 100 land on 8449.999... often enough to matter.
  return Math.round(value * 100);
}
