import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import type {
  InvoiceListStatusFilter,
  InvoiceSummaryDto,
  PaymentMethod,
  PaymentStatus,
} from '@nayaro/shared';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { ApiRequestError } from '@/services/apiClient';
import {
  useInvoiceHistory,
  useInvoiceHistoryRealtime,
} from '@/features/history/hooks/useInvoiceHistory';
import { Page, PageHeader } from '@/components/layout/Page';
import { LoadingState } from '@/components/ui/States';

/**
 * Bills: every invoice for a trading day.
 *
 * The question this answers is "find me that bill" - to reprint it for a
 * customer who came back, to see whether table 4 ever paid, or to void a bill
 * issued in error. A row opens the billing screen, which already does all of
 * that with its own authority checks; this screen adds none of its own.
 *
 * The date is the BUSINESS date. A bill at 01:30 belongs to last night.
 */
const STATUS_FILTERS: ReadonlyArray<{ value: InvoiceListStatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Issued' },
  { value: 'VOID', label: 'Voided' },
];

const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  QR: 'QR',
  CARD: 'Card',
  CREDIT: 'Credit',
};

export function BillsScreen(): JSX.Element {
  const navigate = useNavigate();
  const [date, setDate] = useState<string | null>(null);
  const [status, setStatus] = useState<InvoiceListStatusFilter>('ALL');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');

  // Debounced, so a cashier typing "1204" sends one request, not four.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(typed);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [typed]);

  const history = useInvoiceHistory({ date, status, q });
  useInvoiceHistoryRealtime();

  if (history.isPending)
    return (
      <Page>
        <LoadingState label="Loading bills…" />
      </Page>
    );

  if (history.isError && history.data === undefined) {
    const forbidden = history.error instanceof ApiRequestError && history.error.status === 403;
    return (
      <Page>
        <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
          <h2 className="text-[18px] font-extrabold tracking-tight">
            {forbidden ? 'Bills are not part of your role' : 'Could not load bills'}
          </h2>
          <p className="text-muted mt-2 text-[14px]">
            {forbidden
              ? 'A cashier, manager or owner can look up bills.'
              : 'Nayaro RMS could not be reached. Check your internet connection.'}
          </p>
        </div>
      </Page>
    );
  }

  const data = history.data;
  const shownDate = date ?? data.from;
  const { totals } = data;

  return (
    <Page>
      <PageHeader
        title="Bills"
        description={
          <>Every bill issued on a business day. Open one to reprint, take payment or void it.</>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Bills issued" value={String(totals.activeCount)} />
        <Stat label="Billed" value={formatPaisa(totals.billedPaisa)} />
        <Stat
          label="Settled before refunds"
          value={formatPaisa(totals.paidPaisa)}
          tone="ok"
          note={`${formatPaisa(totals.refundedPaisa)} refunded on these bills`}
        />
        <Stat
          label="Still owed"
          value={formatPaisa(totals.outstandingPaisa)}
          tone={totals.outstandingPaisa > 0 ? 'warn' : undefined}
          note={
            totals.voidCount > 0 ? `${String(totals.voidCount)} voided, not counted` : undefined
          }
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <label className="text-muted flex items-center gap-2 text-[12.5px] font-semibold">
          Business day
          <input
            type="date"
            value={shownDate}
            onChange={(event) => {
              setDate(event.target.value.length > 0 ? event.target.value : null);
            }}
            className="bg-field text-text border-border-3 focus:border-accent-hover rounded-lg border px-2.5 py-1.5 text-[13.5px] outline-none"
          />
        </label>
        {date !== null && (
          <button
            type="button"
            onClick={() => {
              setDate(null);
            }}
            className="text-accent-hover text-[12.5px] font-semibold underline-offset-2 hover:underline"
          >
            Today
          </button>
        )}

        <div className="border-border-3 ml-2 flex overflow-hidden rounded-lg border" role="group">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={status === option.value}
              onClick={() => {
                setStatus(option.value);
              }}
              className={cn(
                'px-3 py-1.5 text-[12.5px] font-bold transition-colors',
                status === option.value
                  ? 'bg-accent text-white'
                  : 'text-muted hover:bg-surface-2 bg-transparent',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={typed}
          placeholder="Bill no., order no., table, buyer or PAN"
          aria-label="Search bills"
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          className="bg-field text-text border-border-3 focus:border-accent-hover ml-auto w-full max-w-[320px] rounded-lg border px-3 py-1.5 text-[13.5px] outline-none"
        />
      </div>

      <div
        className={cn(
          'border-border-2 bg-surface overflow-hidden rounded-card border transition-opacity',
          history.isPlaceholderData && 'opacity-60',
        )}
      >
        {data.invoices.length === 0 ? (
          <p className="text-muted px-6 py-12 text-center text-[14px]">
            {q.length > 0 || status !== 'ALL'
              ? 'No bills match.'
              : 'No bills were issued on this business day.'}
          </p>
        ) : (
          <table className="w-full">
            <thead className="border-border bg-surface-2 border-b">
              <tr className="text-muted font-mono text-[10.5px] font-semibold tracking-widest uppercase">
                <th className="px-4 py-2.5 text-left">Bill</th>
                <th className="px-2 py-2.5 text-left">Time</th>
                <th className="px-2 py-2.5 text-left">Table / order</th>
                <th className="px-2 py-2.5 text-left">Buyer</th>
                <th className="px-2 py-2.5 text-left">Payment</th>
                <th className="px-4 py-2.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((invoice) => (
                <BillRow
                  key={invoice.id}
                  invoice={invoice}
                  onOpen={() => void navigate(`/billing/${invoice.orderId}`)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.truncated && (
        <p className="text-muted-2 mt-3 text-[12px]">
          Showing the newest {String(data.invoices.length)} bills. Search to narrow the list — the
          totals above already cover every match.
        </p>
      )}
    </Page>
  );
}

function BillRow({
  invoice,
  onOpen,
}: {
  invoice: InvoiceSummaryDto;
  onOpen: () => void;
}): JSX.Element {
  const isVoid = invoice.status === 'VOID';
  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
      }}
      className={cn(
        'border-border/70 hover:bg-surface-2 cursor-pointer border-b last:border-b-0',
        'focus-visible:bg-surface-2 outline-none',
        isVoid && 'opacity-60',
      )}
    >
      <td className="px-4 py-2.5">
        <span className={cn('font-mono text-[13.5px] font-bold', isVoid && 'line-through')}>
          #{invoice.invoiceNumber}
        </span>
        <span className="text-muted-2 ml-1.5 font-mono text-[11px]">{invoice.fiscalYearLabel}</span>
        {invoice.invoiceType === 'ABBREVIATED' && (
          <span className="text-muted-2 ml-1.5 text-[10.5px] font-bold">ABBR</span>
        )}
        {invoice.printCount > 0 && (
          <span className="text-muted-2 block text-[11px]">
            Printed {invoice.printCount === 1 ? 'once' : `${String(invoice.printCount)}×`}
          </span>
        )}
      </td>
      <td className="text-muted px-2 py-2.5 text-[13px] whitespace-nowrap">
        {new Date(invoice.issuedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="text-muted-2 block text-[11px]">{invoice.issuedBy.name}</span>
      </td>
      <td className="px-2 py-2.5 text-[13.5px]">
        <span className="font-semibold">{invoice.tableName ?? 'Takeaway'}</span>
        <span className="text-muted-2 block text-[11px]">Order #{invoice.orderNumber}</span>
      </td>
      <td className="px-2 py-2.5 text-[13px]">
        {invoice.buyerName ?? <span className="text-muted-3">—</span>}
        {invoice.buyerPan !== null && (
          <span className="text-muted-2 block font-mono text-[11px]">PAN {invoice.buyerPan}</span>
        )}
      </td>
      <td className="px-2 py-2.5">
        {isVoid ? (
          <Badge tone="danger">Voided</Badge>
        ) : (
          <>
            <SettlementBadge status={invoice.settlementStatus} />
            {invoice.refundedPaisa > 0 && (
              <span className="text-warn-fg block text-xs">
                Refunded {formatPaisa(invoice.refundedPaisa)}
              </span>
            )}
            {invoice.paymentMethods.length > 0 && (
              <span className="text-muted-2 block text-[11px]">
                {invoice.paymentMethods.map((m) => METHOD_LABEL[m]).join(' + ')}
              </span>
            )}
          </>
        )}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-[13.5px] font-bold whitespace-nowrap">
        <span className={cn(isVoid && 'line-through')}>{formatPaisa(invoice.grandTotalPaisa)}</span>
        {invoice.settlementStatus === 'PARTIAL' && !isVoid && (
          <span className="text-muted-2 block text-[11px] font-semibold">
            {formatPaisa(invoice.totalPaidPaisa)} paid
          </span>
        )}
      </td>
    </tr>
  );
}

function SettlementBadge({ status }: { status: PaymentStatus }): JSX.Element {
  if (status === 'PAID') return <Badge tone="ok">Paid</Badge>;
  if (status === 'PARTIAL') return <Badge tone="warn">Part paid</Badge>;
  return <Badge tone="warn">Unpaid</Badge>;
}

function Badge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger';
  children: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'rounded-md px-1.5 py-0.5 text-[11px] font-bold',
        tone === 'ok' && 'bg-ok/12 text-ok-fg',
        tone === 'warn' && 'bg-warn/14 text-warn-fg',
        tone === 'danger' && 'bg-danger/10 text-danger-fg',
      )}
    >
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
  note?: string;
}): JSX.Element {
  return (
    <div className="border-border bg-surface shadow-card rounded-card border px-4 py-3">
      <p className="text-muted font-mono text-[10.5px] font-semibold tracking-widest uppercase">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 font-mono text-[19px] font-extrabold tracking-tight',
          tone === 'ok' && 'text-ok-fg',
          tone === 'warn' && 'text-warn-fg',
        )}
      >
        {value}
      </p>
      {note !== undefined && <p className="text-muted-2 mt-0.5 text-[11px]">{note}</p>}
    </div>
  );
}
