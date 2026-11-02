import type { JSX } from 'react';
import type { BillPaperSpec, InvoiceDto } from '@nayaro/shared';
import { NAYARO_BRAND } from '@nayaro/shared';
import { formatPaisa } from '@/lib/money';

/**
 * The bill, as it goes on paper.
 *
 * Written with INLINE STYLES rather than Tailwind classes, deliberately. This
 * element is rendered into `#print-root`, and a print stylesheet that depends
 * on the app's utility classes surviving into the print context is a bill that
 * comes out unstyled the first time a class name changes. Inline styles are
 * the one thing that cannot be purged, overridden by a media query, or lost.
 *
 * DESIGNED FOR A THERMAL ROLL, which is a genuinely different medium:
 *
 *   - no colour, no grey. Thermal paper is one ink, and a 40% grey renders as
 *     either black or nothing depending on the printer's temperature.
 *   - no background fills, for the same reason, and because a filled row on a
 *     thermal head is slow and drains the roll.
 *   - a monospace column for money so the figures align down the right edge,
 *     which is how anyone reads a total.
 *   - dashed rules instead of borders: a hairline border prints inconsistently
 *     at 203dpi, a row of dashes never does.
 *
 * Everything on it comes from the INVOICE, never from current settings or the
 * live menu. Reprinting last month's bill must reproduce last month's bill,
 * which is why the seller block reads `invoice.seller` and not the restaurant
 * record it was copied from.
 */

export interface ReceiptDocumentProps {
  readonly invoice: InvoiceDto;
  readonly paper: BillPaperSpec;
  /**
   * Which copy this is. 1 is the original; anything higher gets a mark on its
   * face, because two unmarked pieces of paper carrying the same invoice
   * number is a discrepancy nobody can explain later.
   */
  readonly copySequence: number;
  /** Shown as a watermark line when the bill has not been settled yet. */
  readonly unpaid: boolean;
  readonly footerText: string | null;
}

export function ReceiptDocument({
  invoice,
  paper,
  copySequence,
  unpaid,
  footerText,
}: ReceiptDocumentProps): JSX.Element {
  const narrow = paper.id === 'THERMAL_58';
  // 58mm fits about 32 characters. Everything below scales off this.
  const base = narrow ? 10.5 : paper.id === 'A4' ? 12 : 11.5;

  const root: React.CSSProperties = {
    width: paper.widthCss,
    margin: '0 auto',
    padding: paper.continuous ? '0' : '10mm 0',
    color: '#000',
    background: '#fff',
    fontFamily: "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace",
    fontSize: `${String(base)}px`,
    lineHeight: 1.45,
    // Long dish names must wrap rather than push the price off the roll.
    wordBreak: 'break-word',
  };

  return (
    <div style={root}>
      <Centre>
        <div
          style={{ fontSize: `${String(base + 4)}px`, fontWeight: 800, letterSpacing: '-0.02em' }}
        >
          {invoice.seller.name ?? '—'}
        </div>
        {invoice.seller.address !== null && invoice.seller.address.length > 0 && (
          <div>{invoice.seller.address}</div>
        )}
        {invoice.seller.pan !== null && invoice.seller.pan.length > 0 && (
          <div>PAN: {invoice.seller.pan}</div>
        )}
        <div style={{ marginTop: '4px', fontWeight: 700 }}>
          {invoice.invoiceType === 'ABBREVIATED' ? 'ABBREVIATED TAX INVOICE' : 'TAX INVOICE'}
        </div>
      </Centre>

      <Rule />

      {/*
        The identity block. Invoice number and fiscal year travel together
        because the number only means anything within its year - #204 exists
        again next Baisakh.
      */}
      <Row label="Invoice" value={`#${String(invoice.invoiceNumber)}`} />
      <Row label="Fiscal yr" value={invoice.fiscalYearLabel} />
      <Row label="Date" value={new Date(invoice.issuedAt).toLocaleString()} />
      <Row label="Business dt" value={invoice.businessDate} />
      <Row
        label={invoice.orderType === 'TAKEAWAY' ? 'Takeaway' : 'Table'}
        value={invoice.tableName ?? `Order #${String(invoice.orderNumber)}`}
      />
      {invoice.buyer.name !== null && <Row label="Customer" value={invoice.buyer.name} />}
      {invoice.buyer.pan !== null && <Row label="Buyer PAN" value={invoice.buyer.pan} />}

      <Rule />

      {/* Items. Quantity and name on one line, the money hard right. */}
      {invoice.lines.map((line) => (
        <div key={line.id} style={{ marginBottom: '3px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {line.description}
              {line.promotion && (
                <span style={{ display: 'block', fontSize: '0.9em' }}>
                  {line.promotion.name} · {line.promotion.rateBp / 100}% off (normally{' '}
                  {money(line.promotion.regularUnitPricePaisa)})
                </span>
              )}
              {line.descriptionNp !== null && !narrow && (
                <span style={{ display: 'block', opacity: 0.85 }}>{line.descriptionNp}</span>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
            <span>
              {line.quantity} x {money(line.unitPricePaisa)}
            </span>
            <span style={{ fontWeight: 700 }}>{money(line.lineTotalPaisa)}</span>
          </div>
        </div>
      ))}

      <Rule />

      {invoice.loyalty && (
        <div style={{ marginBottom: '6px' }}>
          <p style={{ margin: 0 }}>Loyalty: {invoice.loyalty.customerName}</p>
          <p style={{ margin: 0 }}>
            Points redeemed: {invoice.loyalty.pointsRedeemed} · earned:{' '}
            {invoice.loyalty.pointsEarned}
            {invoice.loyalty.pointsReturned > 0
              ? ` · returned: ${invoice.loyalty.pointsReturned}`
              : ''}
          </p>
        </div>
      )}
      <Row label="Subtotal" value={money(invoice.subtotalPaisa)} mono />
      {invoice.discount.amountPaisa > 0 && (
        <Row
          label={
            invoice.loyalty?.pointsRedeemed
              ? 'Loyalty reward'
              : invoice.discount.type === 'PERCENT'
                ? `Discount ${String(invoice.discount.value / 100)}%`
                : 'Discount'
          }
          value={`-${money(invoice.discount.amountPaisa)}`}
          mono
        />
      )}
      {invoice.serviceCharge.enabled && (
        <Row
          label={`Service ${String(invoice.serviceCharge.rateBp / 100)}%`}
          value={money(invoice.serviceCharge.amountPaisa)}
          mono
        />
      )}
      {invoice.vat.enabled && (
        <Row
          label={`VAT ${String(invoice.vat.rateBp / 100)}%`}
          value={money(invoice.vat.amountPaisa)}
          mono
        />
      )}
      {invoice.roundingAdjustmentPaisa !== 0 && (
        <Row label="Rounding" value={money(invoice.roundingAdjustmentPaisa)} mono />
      )}

      <Rule />

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: `${String(base + 3)}px`,
          fontWeight: 800,
          padding: '2px 0',
        }}
      >
        <span>TOTAL</span>
        <span>{formatPaisa(invoice.grandTotalPaisa)}</span>
      </div>

      <Rule />

      {/* How it was settled. A cashier gets asked this more than anything else. */}
      {invoice.settlement.payments
        .filter((payment) => payment.void === null)
        .map((payment) => (
          <div key={payment.id}>
            <Row label={paymentLabel(payment.method)} value={money(payment.amountPaisa)} mono />
            {payment.refunds.map((refund) => (
              <Row
                key={refund.id}
                label={`Refund ${refund.id.slice(-6)}`}
                value={`-${money(refund.amountPaisa)}`}
                mono
              />
            ))}
            {payment.itemAllocations.map((item) => (
              <div key={item.invoiceLineId} style={{ fontSize: `${String(base - 1)}px` }}>
                {item.quantity} x{' '}
                {invoice.lines.find((line) => line.id === item.invoiceLineId)?.description} —{' '}
                {money(item.amountPaisa)}
              </div>
            ))}
            {payment.changePaisa > 0 && (
              <Row label="  Change" value={money(payment.changePaisa)} mono />
            )}
          </div>
        ))}

      {invoice.settlement.totalPaidPaisa > 0 && (
        <>
          <Row label="Settled" value={money(invoice.settlement.totalPaidPaisa)} mono />
          <Row label="Remaining" value={money(invoice.settlement.remainingPaisa)} mono />
        </>
      )}

      {unpaid && (
        <Centre>
          <div style={{ marginTop: '6px', fontWeight: 800, letterSpacing: '0.1em' }}>
            *** UNPAID — {money(invoice.settlement.remainingPaisa)} DUE ***
          </div>
        </Centre>
      )}

      {/*
        The copy mark. Loud on purpose: its entire job is to stop a reprint
        being mistaken for the original when the two are side by side.
      */}
      {copySequence > 1 && (
        <Centre>
          <div
            style={{
              marginTop: '8px',
              padding: '3px 0',
              border: '1px dashed #000',
              fontWeight: 800,
              letterSpacing: '0.08em',
            }}
          >
            COPY OF ORIGINAL — #{copySequence}
          </div>
        </Centre>
      )}

      <Rule />

      <Centre>
        {footerText !== null && footerText.length > 0 && (
          <div style={{ marginBottom: '4px' }}>{footerText}</div>
        )}
        <div style={{ opacity: 0.85 }}>Thank you — please come again</div>
        {/* The one line that is about the software, kept to one line. */}
        <div style={{ marginTop: '6px', fontSize: `${String(base - 1.5)}px`, opacity: 0.7 }}>
          {NAYARO_BRAND.productName}
          <div>{NAYARO_BRAND.productAttribution}</div>
        </div>
      </Centre>

      {/*
        Feed past the cutter. A roll printer that stops at the last line leaves
        the total inside the machine, and the cashier tears the bill through
        its own figures.
      */}
      {paper.continuous && <div style={{ height: '12mm' }} />}
    </div>
  );
}

function money(paisa: number): string {
  // No currency mark on the line items: on a 58mm roll it costs three
  // characters per line and the header already says what the money is.
  return (paisa / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function paymentLabel(method: string): string {
  switch (method) {
    case 'CASH':
      return 'Cash';
    case 'QR':
      return 'QR / wallet';
    case 'CARD':
      return 'Card';
    case 'CREDIT':
      return 'On credit';
    default:
      return method;
  }
}

function Centre({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ textAlign: 'center' }}>{children}</div>;
}

/** A row of dashes. Prints identically on every thermal head; a border does not. */
function Rule(): JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        borderTop: '1px dashed #000',
        margin: '5px 0',
        height: 0,
      }}
    />
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
      <span style={{ whiteSpace: 'pre' }}>{label}</span>
      <span style={{ fontWeight: mono ? 700 : 400, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
