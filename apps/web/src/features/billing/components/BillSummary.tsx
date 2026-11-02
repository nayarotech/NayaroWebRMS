import type { JSX, ReactNode } from 'react';
import type { PreBillCharge, PreBillDiscount } from '@nayaro/shared';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';

export interface BillSummaryProps {
  readonly discountLabel?: string;
  readonly subtotalPaisa: number;
  readonly discount: PreBillDiscount;
  readonly serviceCharge: PreBillCharge;
  readonly vat: PreBillCharge;
  readonly roundingAdjustmentPaisa: number;
  readonly grandTotalPaisa: number;
}

/**
 * The money, in the order it is calculated.
 *
 * Every figure here comes from the server. The component adds nothing up - it
 * formats. That is what keeps the number on screen and the number on the
 * printed bill the same number.
 *
 * Lines that would be zero and uninformative are hidden: a restaurant with no
 * VAT registration should not see "VAT 0%" on every bill, because a row that is
 * always zero teaches people to stop reading the rows.
 */
export function BillSummary({
  subtotalPaisa,
  discountLabel,
  discount,
  serviceCharge,
  vat,
  roundingAdjustmentPaisa,
  grandTotalPaisa,
}: BillSummaryProps): JSX.Element {
  return (
    <dl className="flex flex-col gap-1.5">
      <Row label="Subtotal" value={formatPaisa(subtotalPaisa)} />

      {discount.amountPaisa > 0 && (
        <Row
          label={
            discountLabel ??
            (discount.type === 'PERCENT'
              ? `Discount (${formatBasisPoints(discount.value)})`
              : 'Discount')
          }
          value={`− ${formatPaisa(discount.amountPaisa)}`}
          tone="discount"
        />
      )}

      {serviceCharge.enabled && (
        <Row
          label={`Service charge (${formatBasisPoints(serviceCharge.rateBp)})`}
          value={formatPaisa(serviceCharge.amountPaisa)}
        />
      )}

      {vat.enabled && (
        <Row
          label={`VAT (${formatBasisPoints(vat.rateBp)})`}
          value={formatPaisa(vat.amountPaisa)}
        />
      )}

      {roundingAdjustmentPaisa !== 0 && (
        <Row
          label="Rounding"
          value={`${roundingAdjustmentPaisa > 0 ? '+' : '−'} ${formatPaisa(Math.abs(roundingAdjustmentPaisa))}`}
          tone="muted"
        />
      )}

      <div className="border-border-2 mt-2 flex items-baseline justify-between border-t pt-2.5">
        <dt className="text-[15px] font-extrabold">Grand total</dt>
        <dd className="font-mono text-[22px] font-extrabold tracking-tight tabular-nums">
          {formatPaisa(grandTotalPaisa)}
        </dd>
      </div>
    </dl>
  );
}

function Row({
  label,
  value,
  tone = 'normal',
}: {
  label: ReactNode;
  value: string;
  tone?: 'normal' | 'muted' | 'discount';
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        className={cn(
          'text-[13px]',
          tone === 'muted' ? 'text-muted-2' : 'text-text-2 font-semibold',
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          'font-mono text-[13.5px] font-semibold tabular-nums',
          tone === 'discount' && 'text-ok-fg',
          tone === 'muted' && 'text-muted-2',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** 1300 -> "13%", 1250 -> "12.5%". Basis points are storage, not display. */
export function formatBasisPoints(bp: number): string {
  const percent = bp / 100;
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0$/, '')}%`;
}
