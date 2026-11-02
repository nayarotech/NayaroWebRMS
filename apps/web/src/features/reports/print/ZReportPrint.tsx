import { useEffect, useRef, type CSSProperties, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DailyReportResponse, PaymentMethod } from '@nayaro/shared';
import { formatPaisa } from '@/lib/money';
import { paperSpec, readPaperPreference } from '@/features/billing/print/paperPreference';

/**
 * Prints the Z report on whatever paper the till prints bills on.
 *
 * Mounting this prints once and calls `onDone`. The flow mirrors the bill
 * printout: swap in an @page rule for the paper, portal the document into
 * #print-root, wait two frames so it has actually painted, then print.
 *
 * Deliberately terse - a thermal roll is 72mm of type. The full detail lives
 * on screen; the printout is what goes in the envelope with the cash.
 */
const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  QR: 'QR',
  CARD: 'Card',
  CREDIT: 'Credit',
};

export function ZReportPrint({
  report,
  restaurantName,
  onDone,
}: {
  report: DailyReportResponse;
  restaurantName: string;
  onDone: () => void;
}): JSX.Element | null {
  const spec = paperSpec(readPaperPreference());
  const target = document.getElementById('print-root');

  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-nayaro-print', 'z-report');
    style.textContent = `@page { size: ${spec.pageSize}; margin: ${spec.continuous ? '0' : '12mm'}; }`;
    document.head.append(style);

    let cancelled = false;
    const frames: number[] = [];
    frames.push(
      requestAnimationFrame(() => {
        frames.push(
          requestAnimationFrame(() => {
            if (cancelled) return;
            window.print();
            doneRef.current();
          }),
        );
      }),
    );
    return () => {
      cancelled = true;
      for (const frame of frames) cancelAnimationFrame(frame);
      style.remove();
    };
  }, [spec.pageSize, spec.continuous]);

  if (target === null) return null;

  const { sales, payments, corrections } = report;
  const correctionCount =
    corrections.voidedInvoices.length +
    corrections.voidedPayments.length +
    corrections.cancelledItems.length +
    corrections.voidedTickets.length;

  return createPortal(
    <div
      style={{
        width: spec.widthCss,
        color: '#000',
        background: '#fff',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: spec.continuous ? '11px' : '12px',
        lineHeight: 1.35,
        padding: spec.continuous ? '2mm 0' : 0,
      }}
    >
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.15em' }}>
        {restaurantName}
      </div>
      <div style={{ textAlign: 'center', fontWeight: 700 }}>END OF DAY (Z) REPORT</div>
      <div style={{ textAlign: 'center' }}>Business day {report.businessDate}</div>
      <div style={{ textAlign: 'center' }}>
        Printed {new Date(report.generatedAt).toLocaleString()}
      </div>

      <Section title="Sales">
        <Row label={`Bills (${String(sales.invoiceCount)})`} value={sales.subtotalPaisa} />
        <Row label="Discounts" value={-sales.discountPaisa} />
        {sales.serviceChargePaisa > 0 && (
          <Row label="Service charge" value={sales.serviceChargePaisa} />
        )}
        {sales.vatPaisa > 0 && <Row label="VAT" value={sales.vatPaisa} />}
        {sales.roundingPaisa !== 0 && <Row label="Rounding" value={sales.roundingPaisa} />}
        <Row label="TOTAL" value={sales.grandTotalPaisa} bold />
        <Row label="Expenses" value={-report.expenses.totalPaisa} />
        <Row
          label="Less refunds & expenses"
          value={report.expenses.salesLessRefundsAndExpensesPaisa}
        />
      </Section>

      <Section title="Payments">
        <Row label="Refunds this day" value={-report.refunds.totalPaisa} />
        {payments.byMethod.map((m) => (
          <Row
            key={m.method}
            label={`${METHOD_LABEL[m.method]} (${String(m.count)})`}
            value={m.amountPaisa}
          />
        ))}
        <Row label="Settled (incl. credit)" value={payments.totalPaisa} bold />
        {payments.outstandingPaisa > 0 && (
          <Row
            label={`Unpaid (${String(payments.unpaidInvoiceCount)})`}
            value={payments.outstandingPaisa}
          />
        )}
      </Section>

      <Section title="Credit collections (not sales)">
        {report.creditCollections.byMethod.map((row) => (
          <Row key={row.method} label={`${METHOD_LABEL[row.method]} (net)`} value={row.netPaisa} />
        ))}
        <Row label="Received" value={report.creditCollections.receivedPaisa} />
        <Row label="Reversed" value={-report.creditCollections.reversedPaisa} />
        <Row label="Net collections" value={report.creditCollections.netPaisa} bold />
      </Section>

      {report.shifts.map((shift, index) => (
        <Section key={shift.id} title={`Drawer ${String(index + 1)} — ${shift.openedBy.name}`}>
          <Row label="Float" value={shift.openingFloatPaisa} />
          <Row label="Cash sales" value={shift.cashSalesPaisa} />
          <Row label="Credit collections (cash, net)" value={shift.cashCreditCollectionsPaisa} />
          {shift.payInsPaisa > 0 && <Row label="Paid in" value={shift.payInsPaisa} />}
          {shift.payOutsPaisa > 0 && <Row label="Paid out" value={-shift.payOutsPaisa} />}
          <Row label="Expected" value={shift.expectedCashPaisa} bold />
          {shift.close === null ? (
            <div>STILL OPEN — not counted</div>
          ) : (
            <>
              <Row label="Counted" value={shift.close.countedCashPaisa} />
              <Row label="Variance" value={shift.close.variancePaisa} bold />
            </>
          )}
        </Section>
      ))}

      <Section title="Top items">
        {report.items.slice(0, 15).map((item) => (
          <Row
            key={`${item.category}:${item.name}`}
            label={`${String(item.quantity)} × ${item.name}`}
            value={item.totalPaisa}
          />
        ))}
      </Section>

      <Section title="Corrections">
        <Row label="Voided bills" count={corrections.voidedInvoices.length} />
        <Row label="Reversed payments" count={corrections.voidedPayments.length} />
        <Row label="Cancelled items" count={corrections.cancelledItems.length} />
        <Row label="Voided tickets" count={corrections.voidedTickets.length} />
        {correctionCount > 0 && <div>Details on the Reports screen.</div>}
      </Section>

      {report.unbilledOrders.length > 0 && (
        <Section title="Warning">
          <div>{report.unbilledOrders.length} order(s) not billed.</div>
        </Section>
      )}

      <div style={{ marginTop: '8mm', borderTop: '1px solid #000', paddingTop: '1mm' }}>
        Counted by
      </div>
      <div style={{ marginTop: '8mm', borderTop: '1px solid #000', paddingTop: '1mm' }}>
        Checked by
      </div>
    </div>,
    target,
  );
}

const rule: CSSProperties = { borderTop: '1px dashed #000', margin: '2mm 0 1mm' };

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div style={rule} />
      <div style={{ fontWeight: 700 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  count,
  bold = false,
}: {
  label: string;
  value?: number;
  count?: number;
  bold?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '2mm', fontWeight: bold ? 700 : 400 }}>
      <span style={{ flex: 1, overflow: 'hidden' }}>{label}</span>
      <span style={{ whiteSpace: 'nowrap' }}>
        {value !== undefined ? formatPaisa(value).replace('₨ ', '') : String(count ?? 0)}
      </span>
    </div>
  );
}
