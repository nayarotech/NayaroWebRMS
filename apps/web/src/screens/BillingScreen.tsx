import { LoyaltyBillPanel } from '@/features/loyalty/LoyaltyBillPanel';
import { useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router';
import type {
  InvoiceDto,
  InvoiceType,
  PreBillDto,
  VoidedInvoiceDto,
  PromotionSummary,
} from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { ApiRequestError } from '@/services/apiClient';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { BillSummary } from '@/features/billing/components/BillSummary';
import { DiscountControl } from '@/features/billing/components/DiscountControl';
import { PaymentPanel } from '@/features/billing/components/PaymentPanel';
import { RefundPanel } from '@/features/operations/RefundPanel';
import {
  useBilling,
  useBillingActions,
  useBillingRealtime,
} from '@/features/billing/hooks/useBilling';
import { PrintBillDialog } from '@/features/billing/print/PrintBillDialog';
import { useSettings } from '@/features/management/hooks/useManagement';
import { CorrectionDialog } from '@/features/corrections/components/CorrectionDialog';
import { useCorrections, useMayCorrect } from '@/features/corrections/hooks/useCorrections';
import { Page, PageHeader } from '@/components/layout/Page';
import { LoadingState } from '@/components/ui/States';

/**
 * Billing: the pre-bill, and then the issued invoice.
 *
 * ONE screen, two states, and the difference between them is the most important
 * thing on it. A pre-bill is a calculation the customer is looking at; an
 * invoice is a numbered document the restaurant's books are made of. The screen
 * says which one is on screen in as many words, because "did we bill this yet?"
 * is a question a busy cashier must never have to guess at.
 *
 * The server decides which state applies - an order with an active invoice
 * returns the document, never a fresh pre-bill.
 */
export function BillingScreen(): JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const orderId = params['orderId'] ?? '';
  const { staff } = useAuth();

  const billing = useBilling(orderId);
  useBillingRealtime(orderId);
  const preBill = billing.data?.preBill ?? null;
  const invoice = billing.data?.invoice ?? null;
  const actions = useBillingActions(
    orderId,
    preBill?.orderVersion ?? null,
    invoice?.orderVersion ?? null,
    invoice?.id ?? null,
  );
  // Payment opens on demand rather than replacing the document view, so a
  // cashier can still read the bill to the customer while taking the money.
  const [paying, setPaying] = useState(false);

  const canDiscount = staff?.role === 'OWNER' || staff?.role === 'MANAGER';
  const corrections = useCorrections();
  const mayCorrect = useMayCorrect();
  const [voidingBill, setVoidingBill] = useState(false);
  const [printingBill, setPrintingBill] = useState(false);

  /*
   * The bill's footer line, for the printout only.
   *
   * Read from settings rather than frozen onto the invoice, and that is
   * correct: the footer is a greeting ("Thank you, come again"), not a term of
   * the sale. Nothing about what the customer was charged depends on it, so a
   * reprint picking up today's wording changes nothing that matters. Every
   * FIGURE on the printout comes from the invoice itself.
   *
   * Cashiers cannot read settings, so the request is not made for them at all
   * - the bill prints without a footer line rather than retrying a 403 on
   * every bill they open.
   */
  const settings = useSettings({
    enabled: staff?.role === 'OWNER' || staff?.role === 'MANAGER',
  });
  const billFooter = settings.data?.operational.billFooterText ?? null;

  if (billing.isPending) {
    return (
      <Page>
        <LoadingState label="Loading the bill…" />
      </Page>
    );
  }

  if (billing.isError && billing.data === undefined) {
    const forbidden = billing.error instanceof ApiRequestError && billing.error.status === 403;
    return (
      <Page>
        <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
          <h2 className="text-[18px] font-extrabold tracking-tight">
            {forbidden ? 'Billing is not part of your role' : 'Could not open this bill'}
          </h2>
          <p className="text-muted mt-2 text-[14px] leading-relaxed">
            {billing.error instanceof ApiRequestError && billing.error.kind === 'http'
              ? billing.error.message
              : 'Nayaro RMS could not be reached. Check your connection and try again.'}
          </p>
          <Button variant="secondary" className="mt-6" onClick={() => void navigate('/tables')}>
            Back to tables
          </Button>
        </div>
      </Page>
    );
  }

  const heading = invoice ?? preBill;
  const label = heading?.tableName ?? 'Takeaway';

  return (
    <Page className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        <PageHeader
          back={{ to: '/tables', label: 'Tables' }}
          title={label}
          description={`Order #${String(heading?.orderNumber ?? '—')}${heading?.orderType === 'TAKEAWAY' ? ' · Takeaway' : ''}`}
        />

        <VoidedBills invoices={billing.data?.voidedInvoices ?? []} />
        <LoyaltyBillPanel
          orderId={orderId}
          busy={actions.isSaving}
          canReturnRewards={canDiscount}
        />

        {invoice === null ? (
          <PreBillPanel preBill={preBill} />
        ) : (
          <InvoicePanel invoice={invoice} corrections={corrections} mayCorrect={mayCorrect} />
        )}
      </div>

      <aside id="order-panel" className="w-full shrink-0 scroll-mt-20 md:sticky md:top-6 md:w-[320px] lg:w-[380px] xl:w-[420px]">
        <div className="border-border-2 bg-surface flex md:max-h-[calc(100dvh-8.5rem)] flex-col overflow-hidden rounded-card border">
          <header
            className={cn(
              'border-border border-b px-5 py-4',
              invoice === null ? 'bg-warn/10' : 'bg-ok/10',
            )}
          >
            {invoice === null ? (
              <>
                <h2 className="text-warn-fg text-[15px] font-extrabold tracking-tight">PRE-BILL</h2>
                <p className="text-warn-fg/90 mt-0.5 text-[11.5px] font-bold">NOT A TAX INVOICE</p>
              </>
            ) : (
              <>
                <h2 className="text-ok-fg text-[15px] font-extrabold tracking-tight">
                  {invoice.invoiceType === 'ABBREVIATED'
                    ? 'ABBREVIATED TAX INVOICE'
                    : 'TAX INVOICE'}
                </h2>
                <p className="text-ok-fg/90 mt-0.5 font-mono text-[12px] font-bold">
                  #{invoice.invoiceNumber} · {invoice.fiscalYearLabel}
                </p>
              </>
            )}
          </header>

          {actions.notice !== null && (
            <p
              role="status"
              className="border-warn/40 bg-warn/10 text-warn-fg m-4 mb-0 rounded-xl border px-3.5 py-2.5 text-[12.5px] font-semibold"
            >
              {actions.notice}
              <button
                type="button"
                onClick={actions.dismissNotice}
                className="ml-2 underline underline-offset-2"
              >
                Dismiss
              </button>
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {preBill?.kitchenWarning != null && (
              <p className="border-warn/40 bg-warn/10 text-warn-fg mb-3 rounded-xl border px-3 py-2 text-[12px] font-semibold">
                {preBill.kitchenWarning}
              </p>
            )}

            {heading?.loyalty && (
              <p className="text-muted mb-3 text-sm">
                {heading.loyalty.customerName} · {heading.loyalty.pointsRedeemed} points redeemed ·{' '}
                {heading.loyalty.pointsEarned} points earned
                {heading.loyalty.pointsReturned > 0
                  ? ` · ${heading.loyalty.pointsReturned} points returned`
                  : ''}
              </p>
            )}
            <BillSummary
              subtotalPaisa={heading?.subtotalPaisa ?? 0}
              discountLabel={heading?.loyalty?.pointsRedeemed ? 'Loyalty reward' : undefined}
              discount={heading?.discount ?? { type: 'NONE', value: 0, amountPaisa: 0 }}
              serviceCharge={
                heading?.serviceCharge ?? { enabled: false, rateBp: 0, amountPaisa: 0 }
              }
              vat={heading?.vat ?? { enabled: false, rateBp: 0, amountPaisa: 0 }}
              roundingAdjustmentPaisa={heading?.roundingAdjustmentPaisa ?? 0}
              grandTotalPaisa={heading?.grandTotalPaisa ?? 0}
            />

            {preBill !== null && !preBill.loyalty?.pointsRedeemed && (
              <div className="mt-4">
                <DiscountControl
                  discount={preBill.discount}
                  subtotalPaisa={preBill.subtotalPaisa}
                  canEdit={canDiscount}
                  busy={actions.isSaving}
                  onApply={(type, value) => void actions.setDiscount(type, value)}
                />
              </div>
            )}
          </div>

          <footer className="border-border bg-surface-2 max-h-[60vh] shrink-0 overflow-y-auto border-t px-5 py-4">
            {preBill !== null && <IssueForm preBill={preBill} actions={{ ...actions }} />}
            {/*
             * Voiding is offered only on a live, unpaid bill. The server
             * refuses everything else - a settled sale needs a refund, and a
             * bill with money on it needs the payment reversed first - and
             * offering the button anyway would be offering a dead end.
             */}
            {invoice !== null &&
              mayCorrect &&
              invoice.settlement.totalPaidPaisa === 0 &&
              invoice.settlement.status !== 'PAID' && (
                <Button
                  variant="danger"
                  className="mb-2 w-full"
                  disabled={corrections.isSaving}
                  onClick={() => {
                    setVoidingBill(true);
                  }}
                >
                  Void this bill
                </Button>
              )}
            {/*
             * Print. Offered only once an invoice exists, because a pre-bill
             * is a calculation and not a document - printing one would hand a
             * customer something that looks like a bill and has no number.
             * Voided invoices are refused by the server too.
             */}
            {invoice !== null && invoice.status === 'ACTIVE' && (
              <Button
                variant="secondary"
                className="mb-2 w-full"
                onClick={() => {
                  setPrintingBill(true);
                }}
              >
                {invoice.printCount === 0
                  ? 'Print bill'
                  : `Print again (copy #${String(invoice.printCount + 1)})`}
              </Button>
            )}
            {invoice !== null && (
              <IssuedFooter
                invoice={invoice}
                actions={actions}
                paying={paying}
                onStartPaying={() => {
                  setPaying(true);
                }}
                onViewInvoice={() => {
                  setPaying(false);
                }}
                onBack={() => void navigate('/tables')}
              />
            )}
          </footer>
        </div>
      </aside>

      {printingBill && invoice !== null && (
        <PrintBillDialog
          invoice={invoice}
          footerText={billFooter}
          onClose={() => {
            setPrintingBill(false);
            // The print count changed on the server, so the button's own
            // wording ("copy #3") is now stale.
            void billing.refetch();
          }}
        />
      )}

      <CorrectionDialog
        open={voidingBill}
        title={invoice === null ? 'Void bill' : `Void invoice #${String(invoice.invoiceNumber)}?`}
        consequence={
          invoice === null
            ? ''
            : `Invoice #${String(invoice.invoiceNumber)} will be kept as a voided document and its number will never be reused. The order reopens so it can be corrected and billed again with a new number.`
        }
        confirmLabel="Void the bill"
        busy={corrections.isSaving}
        error={corrections.error}
        onClose={() => {
          setVoidingBill(false);
          corrections.clearError();
        }}
        onConfirm={(reason) => {
          if (invoice === null) return;
          void corrections.voidInvoice(invoice.id, reason).then((ok) => {
            if (ok) setVoidingBill(false);
          });
        }}
      />
    </Page>
  );
}

/**
 * The three states an issued bill can be in: unpaid and waiting, being paid,
 * or settled. Split out so `invoice` is non-null by construction rather than
 * by a boolean the type checker cannot follow.
 */
function IssuedFooter({
  invoice,
  actions,
  paying,
  onStartPaying,
  onViewInvoice,
  onBack,
}: {
  invoice: InvoiceDto;
  actions: ReturnType<typeof useBillingActions>;
  paying: boolean;
  onStartPaying: () => void;
  onViewInvoice: () => void;
  onBack: () => void;
}): JSX.Element {
  if (invoice.settlement.status === 'PAID') {
    return <SettledActions invoice={invoice} onBack={onBack} onViewInvoice={onViewInvoice} />;
  }

  if (paying || invoice.grandTotalPaisa === 0) {
    return (
      <PaymentPanel
        // Refresh selections after any payment or correction, including from another till.
        key={`${invoice.id}:${invoice.orderVersion}`}
        invoice={invoice}
        busy={actions.isSaving}
        onPay={(input) => void actions.pay(input)}
        onSettleZero={() => void actions.settleZero()}
      />
    );
  }

  return (
    <>
      <Button size="lg" className="w-full" onClick={onStartPaying}>
        Continue to Payment
      </Button>
      <p className="text-muted-2 mt-2 text-center text-[11.5px]">
        {formatPaisa(invoice.settlement.remainingPaisa)} still to pay.
      </p>
    </>
  );
}

/**
 * What a cashier sees the moment the money is in.
 *
 * "Back to Tables" is the primary action because it is what happens next: the
 * customer leaves, the table is free, and somebody is waiting for it. Leaving
 * the cashier on a spent payment form is how a till ends up with two people
 * arguing about whether the bill was paid.
 */
function SettledActions({
  invoice,
  onBack,
  onViewInvoice,
}: {
  invoice: InvoiceDto;
  onBack: () => void;
  onViewInvoice: () => void;
}): JSX.Element {
  const change = invoice.settlement.payments.reduce((total, p) => total + p.changePaisa, 0);

  return (
    <div>
      <div className="border-ok/40 bg-ok/10 mb-3 rounded-xl border px-3.5 py-3 text-center">
        <p className="text-ok-fg text-[15px] font-extrabold">Payment complete</p>
        <p className="text-ok-fg/90 mt-0.5 text-[12.5px] font-semibold">
          {invoice.tableName === null
            ? 'This takeaway order is closed.'
            : `${invoice.tableName} is now available.`}
        </p>
        {change > 0 && (
          <p className="text-ok-fg mt-1.5 font-mono text-[13px] font-bold">
            Change given {formatPaisa(change)}
          </p>
        )}
      </div>
      <Button size="lg" className="w-full" onClick={onBack}>
        Back to Tables
      </Button>
      <Button variant="secondary" className="mt-2 w-full" onClick={onViewInvoice}>
        View Invoice
      </Button>
    </div>
  );
}

function PreBillPanel({ preBill }: { preBill: PreBillDto | null }): JSX.Element {
  if (preBill === null) return <p className="text-muted text-sm">Nothing to bill.</p>;

  return (
    <section aria-label="Pre-bill items">
      <div className="border-warn/40 bg-warn/8 mb-4 rounded-xl border px-4 py-2.5">
        <p className="text-warn-fg text-[12.5px] font-bold">
          This is a pre-bill. It is not a tax invoice and has no invoice number.
        </p>
      </div>
      <LineTable
        lines={preBill.lines.map((line) => ({
          key: line.orderItemId,
          name: line.name,
          nameNp: line.nameNp,
          quantity: line.billableQuantity,
          note:
            line.cancelledQuantity > 0
              ? `${String(line.quantity)} ordered, ${String(line.cancelledQuantity)} cancelled`
              : null,
          unitPricePaisa: line.unitPricePaisa,
          promotion: line.promotion,
          lineTotalPaisa: line.lineTotalPaisa,
        }))}
      />
    </section>
  );
}

function InvoicePanel({
  invoice,
  corrections,
  mayCorrect,
}: {
  invoice: InvoiceDto;
  corrections: ReturnType<typeof useCorrections>;
  mayCorrect: boolean;
}): JSX.Element {
  const [reversing, setReversing] = useState<InvoiceDto['settlement']['payments'][number] | null>(
    null,
  );
  return (
    <section aria-label="Invoice">
      <div className="border-ok/40 bg-ok/8 mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5">
        <p className="text-ok-fg text-[12.5px] font-bold">
          Issued {new Date(invoice.issuedAt).toLocaleString()}
        </p>
        <p className="text-muted-2 font-mono text-[11.5px] font-semibold">
          Business date {invoice.businessDate}
        </p>
      </div>

      {(invoice.buyer.name !== null || invoice.buyer.pan !== null) && (
        <dl className="border-border-2 bg-surface mb-4 grid grid-cols-3 gap-3 rounded-xl border px-4 py-3">
          {invoice.buyer.name !== null && <Fact label="Buyer" value={invoice.buyer.name} />}
          {invoice.buyer.pan !== null && <Fact label="PAN" value={invoice.buyer.pan} mono />}
          {invoice.buyer.address !== null && <Fact label="Address" value={invoice.buyer.address} />}
        </dl>
      )}

      <LineTable
        lines={invoice.lines.map((line) => ({
          key: line.id,
          name: line.description,
          nameNp: line.descriptionNp,
          quantity: line.quantity,
          note: null,
          unitPricePaisa: line.unitPricePaisa,
          promotion: line.promotion,
          lineTotalPaisa: line.lineTotalPaisa,
        }))}
      />

      {invoice.settlement.payments.length > 0 && (
        <div className="border-border-2 bg-surface mt-4 rounded-card border px-4 py-3">
          <p className="text-muted mb-2 font-mono text-[10.5px] font-semibold tracking-widest uppercase">
            Payments
          </p>
          <ul className="flex flex-col gap-1.5">
            {invoice.settlement.payments.map((payment) => (
              <li key={payment.id} className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    'text-[13px] font-semibold',
                    payment.void !== null && 'text-muted-2 line-through',
                  )}
                >
                  {payment.method === 'CREDIT' ? 'Credit' : payment.method}
                  {payment.reference !== null && (
                    <span className="text-muted-2 ml-2 font-mono text-[11.5px]">
                      {payment.reference}
                    </span>
                  )}
                  {payment.creditAccountName !== null && (
                    <span className="text-muted-2 ml-2 text-[11.5px]">
                      {payment.creditAccountName}
                    </span>
                  )}
                  <span className="text-muted-2 ml-2 text-[11.5px]">{payment.receivedBy.name}</span>
                  {payment.itemAllocations.map((item) => (
                    <span key={item.invoiceLineId} className="text-muted-2 block text-xs">
                      {item.quantity} ×{' '}
                      {invoice.lines.find((line) => line.id === item.invoiceLineId)?.description} ·{' '}
                      {formatPaisa(item.amountPaisa)}
                    </span>
                  ))}
                  {payment.void !== null && (
                    <span className="text-danger ml-2 block text-[11.5px] font-semibold no-underline">
                      Reversed — {payment.void.reason} ({payment.void.voidedBy.name})
                    </span>
                  )}
                </span>
                <span className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'font-mono text-[13px] font-bold tabular-nums',
                      payment.void !== null && 'text-muted-2 line-through',
                    )}
                  >
                    {formatPaisa(payment.amountPaisa)}
                    {payment.tenderedPaisa !== null && payment.changePaisa > 0 && (
                      <span className="text-muted-2 ml-2 text-[11px] font-semibold">
                        from {formatPaisa(payment.tenderedPaisa)}
                      </span>
                    )}
                  </span>
                  {/*
                   * Offered only while the sale is still open. Once the order
                   * is PAID the money is settled and reversing it is a refund,
                   * which the server refuses and this phase does not build.
                   */}
                  {mayCorrect && payment.void === null && invoice.settlement.remainingPaisa > 0 && (
                    <button
                      type="button"
                      disabled={corrections.isSaving}
                      onClick={() => {
                        setReversing(payment);
                      }}
                      className="text-muted-2 hover:text-danger text-[11.5px] font-semibold disabled:opacity-50"
                    >
                      Reverse
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <RefundPanel invoice={invoice} mayRefund={mayCorrect} />
      <CorrectionDialog
        open={reversing !== null}
        title={
          reversing === null
            ? 'Reverse payment'
            : `Reverse ${reversing.method === 'CREDIT' ? 'credit' : reversing.method.toLowerCase()} payment of ${formatPaisa(reversing.amountPaisa)}?`
        }
        consequence={
          reversing === null
            ? ''
            : `The payment stays on the bill, marked reversed, and counts for nothing. The amount still to pay will rise by ${formatPaisa(reversing.amountPaisa)}.`
        }
        confirmLabel="Reverse it"
        busy={corrections.isSaving}
        error={corrections.error}
        onClose={() => {
          setReversing(null);
          corrections.clearError();
        }}
        onConfirm={(reason) => {
          if (reversing === null) return;
          void corrections.voidPayment(reversing.id, reason).then((ok) => {
            if (ok) setReversing(null);
          });
        }}
      />
    </section>
  );
}

interface DisplayLine {
  key: string;
  name: string;
  nameNp: string | null;
  quantity: number;
  note: string | null;
  unitPricePaisa: number;
  promotion?: PromotionSummary | null;
  lineTotalPaisa: number;
}

function LineTable({ lines }: { lines: readonly DisplayLine[] }): JSX.Element {
  return (
    <div className="border-border-2 bg-surface overflow-hidden rounded-card border">
      <table className="w-full">
        <thead className="border-border bg-surface-2 border-b">
          <tr className="text-muted font-mono text-[10.5px] font-semibold tracking-widest uppercase">
            <th className="px-4 py-2.5 text-left">Item</th>
            <th className="px-2 py-2.5 text-right">Qty</th>
            <th className="px-2 py-2.5 text-right">Rate</th>
            <th className="px-4 py-2.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="border-border/70 border-b last:border-b-0">
              <td className="px-4 py-2.5">
                <span className="text-[14px] font-bold">{line.name}</span>
                {line.promotion && (
                  <span className="text-accent block text-xs">
                    {line.promotion.name} · {line.promotion.rateBp / 100}% off · normally{' '}
                    {formatPaisa(line.promotion.regularUnitPricePaisa)}
                  </span>
                )}
                {line.nameNp !== null && (
                  <span className="text-muted-2 ml-2 text-[12px]">{line.nameNp}</span>
                )}
                {line.note !== null && (
                  <span className="text-muted-2 block text-[11.5px]">{line.note}</span>
                )}
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-[13.5px] font-bold tabular-nums">
                {line.quantity}
              </td>
              <td className="text-muted-2 px-2 py-2.5 text-right font-mono text-[13px] tabular-nums">
                {formatPaisa(line.unitPricePaisa)}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[13.5px] font-bold tabular-nums">
                {formatPaisa(line.lineTotalPaisa)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Buyer details and invoice type, then the one irreversible button on the
 * screen. ABBREVIATED is never selected by the amount - a person chooses it,
 * and only when the restaurant is set up for it and the bill is under the
 * limit. STANDARD is always available.
 */
function IssueForm({
  preBill,
  actions,
}: {
  preBill: PreBillDto;
  actions: ReturnType<typeof useBillingActions>;
}): JSX.Element {
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('STANDARD');
  const [buyerName, setBuyerName] = useState('');
  const [buyerPan, setBuyerPan] = useState('');
  const nothingToBill = preBill.lines.length === 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void actions.issue({
          invoiceType,
          buyerName: buyerName.trim(),
          buyerPan: buyerPan.trim(),
        });
      }}
    >
      <div className="mb-3 grid grid-cols-2 gap-2">
        <input
          aria-label="Buyer name"
          placeholder="Buyer name (optional)"
          value={buyerName}
          maxLength={120}
          onChange={(event) => {
            setBuyerName(event.target.value);
          }}
          className="bg-field border-border-3 focus:border-accent-hover rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none"
        />
        <input
          aria-label="Buyer PAN"
          placeholder="PAN (optional)"
          value={buyerPan}
          inputMode="numeric"
          maxLength={9}
          onChange={(event) => {
            setBuyerPan(event.target.value);
          }}
          className="bg-field border-border-3 focus:border-accent-hover rounded-lg border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
        />
      </div>

      <div role="group" aria-label="Invoice type" className="mb-3 flex gap-1.5">
        <TypeButton
          active={invoiceType === 'STANDARD'}
          onClick={() => {
            setInvoiceType('STANDARD');
          }}
        >
          Standard tax invoice
        </TypeButton>
        <TypeButton
          active={invoiceType === 'ABBREVIATED'}
          disabled={!preBill.abbreviated.available}
          title={preBill.abbreviated.unavailableReason ?? undefined}
          onClick={() => {
            setInvoiceType('ABBREVIATED');
          }}
        >
          Abbreviated
        </TypeButton>
      </div>
      {!preBill.abbreviated.available && preBill.abbreviated.unavailableReason !== null && (
        <p className="text-muted-2 mb-3 text-[11.5px]">{preBill.abbreviated.unavailableReason}</p>
      )}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={actions.isSaving}
        disabled={actions.isSaving || nothingToBill}
      >
        {actions.isSaving ? 'Issuing…' : 'Issue Invoice'}
      </Button>
      <p className="text-muted-2 mt-2 text-center text-[11.5px]">
        {nothingToBill
          ? 'There is nothing to bill on this order.'
          : 'Once issued, the invoice cannot be edited.'}
      </p>
    </form>
  );
}

function TypeButton({
  children,
  active,
  disabled = false,
  title,
  onClick,
}: {
  children: string;
  active: boolean;
  disabled?: boolean;
  title?: string | undefined;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      {...(title === undefined ? {} : { title })}
      onClick={onClick}
      className={cn(
        'flex-1 rounded-lg border px-2 py-1.5 text-[12px] font-bold transition-colors',
        active
          ? 'border-accent bg-accent text-white'
          : 'border-border-2 bg-surface text-text-2 hover:border-accent-hover',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {children}
    </button>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted font-mono text-[10px] font-semibold tracking-widest uppercase">
        {label}
      </dt>
      <dd className={cn('truncate text-[13px] font-bold', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

/**
 * Bills that were issued for this order and then withdrawn.
 *
 * Shown on the billing screen itself rather than tucked into a history nobody
 * opens, because the question it answers is asked here: "I printed a bill for
 * this table, why is it asking me to bill it again?" The answer is a number, a
 * reason and a name.
 *
 * The number is stated as spent on purpose. An invoice series with a reused
 * number is a series nobody can audit, and a cashier who understands that the
 * next bill will say #13 does not phone anyone about the gap.
 */
function VoidedBills({ invoices }: { invoices: readonly VoidedInvoiceDto[] }): JSX.Element | null {
  if (invoices.length === 0) return null;

  return (
    <div className="border-danger/40 bg-danger/10 mb-4 rounded-card border px-4 py-3">
      <p className="text-danger-fg font-mono text-[10.5px] font-bold tracking-widest uppercase">
        {invoices.length === 1 ? 'Voided bill' : 'Voided bills'}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {invoices.map((voided) => (
          <li key={voided.id} className="text-[12.5px] leading-relaxed">
            <span className="text-danger-fg font-mono font-bold">
              #{voided.invoiceNumber} · {voided.fiscalYearLabel}
            </span>{' '}
            <span className="text-muted-2 font-mono">{formatPaisa(voided.grandTotalPaisa)}</span>
            <span className="text-danger-fg/90 block font-semibold">
              {voided.reason} — {voided.voidedBy.name}, {new Date(voided.voidedAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted mt-1.5 text-[11.5px]">
        {invoices.length === 1 ? 'That number is' : 'Those numbers are'} used up and will never be
        reissued.
      </p>
    </div>
  );
}
