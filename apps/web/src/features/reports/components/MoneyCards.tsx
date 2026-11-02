import type { JSX } from 'react';
import { Info, Undo2 } from 'lucide-react';
import type { DailyReportResponse } from '@nayaro/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { formatTime } from '@/lib/dates';
import { METHOD_LABEL, METHOD_SWATCH, MoneyRow, SplitBar, SubHeading } from './ReportParts';

/**
 * Where the money came from: item totals down to net sales, then what is left
 * once refunds and expenses come out. Read top to bottom like the bill itself.
 */
export function SalesCard({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  const { sales, byOrderType, expenses, refunds } = report;
  const kept = expenses.salesLessRefundsAndExpensesPaisa;

  return (
    <Card>
      <CardHeader title="Where the money came from" description="From item prices to what the restaurant keeps." />
      <CardBody className="space-y-5">
        <div>
          <MoneyRow label="Item totals" value={sales.subtotalPaisa} />
          <MoneyRow
            label="Discounts"
            value={-sales.discountPaisa}
            tone={sales.discountPaisa > 0 ? 'danger' : undefined}
            muted={sales.discountPaisa === 0}
          />
          <MoneyRow label="Service charge" value={sales.serviceChargePaisa} muted={sales.serviceChargePaisa === 0} />
          <MoneyRow label="VAT" value={sales.vatPaisa} muted={sales.vatPaisa === 0} />
          <MoneyRow label="Rounding" value={sales.roundingPaisa} muted={sales.roundingPaisa === 0} />
          <MoneyRow label="Net sales" value={sales.grandTotalPaisa} strong />
        </div>

        <div>
          <SubHeading>By order type</SubHeading>
          <SplitBar
            label="Sales by order type"
            segments={byOrderType.map((row) => ({
              key: row.type,
              label: row.type === 'DINE_IN' ? 'Dine-in' : 'Takeaway',
              note: `${String(row.invoiceCount)} bill${row.invoiceCount === 1 ? '' : 's'}`,
              value: row.grandTotalPaisa,
              swatch: row.type === 'DINE_IN' ? 'bg-accent' : 'bg-accent/40',
            }))}
          />
        </div>

        <div className="bg-surface-2 border-border rounded-control border px-4 py-3">
          <MoneyRow label="Net sales" value={sales.grandTotalPaisa} />
          <MoneyRow label="Refunds" value={-refunds.totalPaisa} muted={refunds.totalPaisa === 0} />
          <MoneyRow label="Expenses" value={-expenses.totalPaisa} muted={expenses.totalPaisa === 0} />
          <div className="border-border mt-1 flex items-baseline border-t pt-2.5">
            <span className="flex-1 text-body font-bold">Left after refunds and expenses</span>
            <span
              className={cn(
                'font-mono text-heading font-extrabold tabular-nums',
                kept < 0 ? 'text-danger-fg' : 'text-ok-fg',
              )}
            >
              {formatPaisa(kept)}
            </span>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** How it was paid, what went back out as refunds, and old credit collected today. */
export function PaymentsCard({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  const { payments, refunds, creditCollections } = report;
  const hasCredit = payments.byMethod.some((row) => row.method === 'CREDIT' && row.amountPaisa > 0);

  return (
    <Card>
      <CardHeader title="How it was paid" description="Payments recorded against this day's bills." />
      <CardBody className="space-y-5">
        {payments.byMethod.length === 0 ? (
          <EmptyState title="No payments recorded" className="py-8" />
        ) : (
          <div>
            <SplitBar
              label="Payments by method"
              segments={payments.byMethod.map((row) => ({
                key: row.method,
                label: METHOD_LABEL[row.method],
                note: `${String(row.count)} payment${row.count === 1 ? '' : 's'}`,
                value: row.amountPaisa,
                swatch: METHOD_SWATCH[row.method],
              }))}
            />
            <MoneyRow label="Settled" hint="including credit" value={payments.totalPaisa} strong />
            {payments.outstandingPaisa > 0 && (
              <MoneyRow
                label="Still unpaid"
                hint={`${String(payments.unpaidInvoiceCount)} bill${payments.unpaidInvoiceCount === 1 ? '' : 's'}`}
                value={payments.outstandingPaisa}
                tone="warn"
              />
            )}
            {hasCredit && (
              <p className="text-muted-2 mt-2 flex items-start gap-1.5 text-caption">
                <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
                Credit counts as settled but is not cash: it is money customers still owe.
              </p>
            )}
          </div>
        )}

        <div>
          <SubHeading>Refunds</SubHeading>
          {refunds.rows.length === 0 ? (
            <p className="text-muted-3 text-body">No refunds.</p>
          ) : (
            <ul className="divide-border divide-y">
              {refunds.rows.map((row) => (
                <li key={row.id} className="flex items-start gap-3 py-2 text-body">
                  <Undo2 size={15} aria-hidden className="text-danger-fg mt-1 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {METHOD_LABEL[row.method]} refund
                      <span className="text-muted-2 ml-1.5 text-caption font-medium">
                        {row.staff.name} · {formatTime(row.createdAt)}
                      </span>
                    </p>
                    <p className="text-muted truncate text-caption">“{row.reason}”</p>
                  </div>
                  <span className="text-danger-fg font-mono tabular-nums">{formatPaisa(-row.amountPaisa)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <SubHeading>Credit collected today</SubHeading>
          {creditCollections.receivedPaisa === 0 && creditCollections.reversedPaisa === 0 ? (
            <p className="text-muted-3 text-body">No repayments from credit customers.</p>
          ) : (
            <>
              {creditCollections.byMethod.map((row) => (
                <MoneyRow key={row.method} label={METHOD_LABEL[row.method]} value={row.netPaisa} />
              ))}
              {creditCollections.reversedPaisa > 0 && (
                <MoneyRow label="Reversed" value={-creditCollections.reversedPaisa} tone="danger" />
              )}
              <MoneyRow label="Collected" hint="separate from sales" value={creditCollections.netPaisa} strong />
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
