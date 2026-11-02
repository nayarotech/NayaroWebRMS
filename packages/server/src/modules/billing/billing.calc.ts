import type { DiscountType, OrderType } from '@nayaro/database';
import { applyRateBp, roundToRupee } from '../../utils/money';

/**
 * THE BILL CALCULATION. One function, one place, used by everything.
 *
 * The pre-bill preview, the invoice that gets issued and the tests all call
 * this. A second implementation anywhere - most temptingly in React, to avoid
 * a round trip - is how a customer ends up seeing one total on screen and
 * another on paper.
 *
 * It is a pure function of its inputs: no database, no clock, no settings
 * lookup. That is what makes every edge case below testable directly, and what
 * lets the issuance transaction reuse it without re-querying anything.
 *
 * THE PIPELINE, and what it is:
 *
 *   subtotal        = SUM(billableQuantity x unitPrice)
 *   base            = subtotal - discount
 *   serviceCharge   = roundHalfUp(base x serviceChargeRateBp / 10000)
 *   vat             = roundHalfUp((base + serviceCharge) x vatRateBp / 10000)
 *   preRounded      = base + serviceCharge + vat
 *   grandTotal      = preRounded, optionally snapped to the nearest rupee
 *   adjustment      = grandTotal - preRounded
 *
 * This is a PRODUCT CONFIGURATION, deliberately: which charges apply, at what
 * rates, and whether VAT is computed on top of service charge are all settings
 * an owner controls. It is not a statement about what any tax authority
 * requires - that is a separate question, and this code does not answer it.
 * Changing the order of operations here changes what customers are charged, so
 * it belongs in one reviewed place rather than scattered across callers.
 *
 * The identity the database enforces holds by construction:
 *   subtotal - discount + serviceCharge + vat + adjustment = grandTotal
 */

export interface BillableLine {
  readonly promotionSnapshot?: string | null;
  readonly orderItemId: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly quantity: number;
  readonly cancelledQuantity: number;
  readonly unitPricePaisa: number;
}

export interface BillingConfig {
  readonly vatEnabled: boolean;
  readonly vatRateBp: number;
  readonly serviceChargeEnabled: boolean;
  readonly serviceChargeRateBp: number;
  readonly serviceChargeAppliesToTakeaway: boolean;
  readonly roundGrandTotalToRupee: boolean;
}

export interface DiscountInput {
  readonly type: DiscountType;
  /** Basis points for PERCENT, paisa for FIXED. Ignored for NONE. */
  readonly value: number;
}

export interface CalculatedLine extends BillableLine {
  readonly billableQuantity: number;
  readonly lineTotalPaisa: number;
}

export interface CalculatedBill {
  readonly lines: readonly CalculatedLine[];
  readonly subtotalPaisa: number;
  readonly discountType: DiscountType;
  readonly discountValue: number;
  readonly discountPaisa: number;
  /** The rate actually used: 0 when the charge is switched off. */
  readonly serviceChargeRateBp: number;
  readonly serviceChargePaisa: number;
  readonly vatRateBp: number;
  readonly vatPaisa: number;
  readonly roundingAdjustmentPaisa: number;
  readonly grandTotalPaisa: number;
}

export function calculateBill(input: {
  readonly lines: readonly BillableLine[];
  readonly orderType: OrderType;
  readonly discount: DiscountInput;
  readonly config: BillingConfig;
}): CalculatedBill {
  // 1. Billable lines. A line whose whole quantity was cancelled bills for
  //    nothing and is dropped - the database refuses a zero-quantity invoice
  //    line, and a bill listing "Momo x0" would be nonsense on paper anyway.
  const lines: CalculatedLine[] = input.lines
    .map((line) => {
      const billableQuantity = Math.max(0, line.quantity - line.cancelledQuantity);
      return {
        ...line,
        billableQuantity,
        lineTotalPaisa: billableQuantity * line.unitPricePaisa,
      };
    })
    .filter((line) => line.billableQuantity > 0);

  const subtotalPaisa = lines.reduce((total, line) => total + line.lineTotalPaisa, 0);

  // 2. Discount, never more than the subtotal. A bill cannot go negative, and
  //    clamping here means a stale 100%-of-a-bigger-order discount degrades to
  //    "free" rather than to a refund.
  const discountPaisa = Math.min(subtotalPaisa, resolveDiscount(input.discount, subtotalPaisa));
  const basePaisa = subtotalPaisa - discountPaisa;

  // 3. Service charge. Takeaway is a separate decision from the master switch:
  //    a restaurant that adds 10% for table service usually does not add it to
  //    a bag someone carries out.
  const serviceChargeApplies =
    input.config.serviceChargeEnabled &&
    (input.orderType === 'DINE_IN' || input.config.serviceChargeAppliesToTakeaway);
  // The EFFECTIVE rate is snapshotted, not the configured one: an invoice that
  // says "service charge 0%" and "amount 0" is self-explanatory years later,
  // whereas "10%" next to "0.00" reads like a bug.
  const serviceChargeRateBp = serviceChargeApplies ? input.config.serviceChargeRateBp : 0;
  const serviceChargePaisa = applyRateBp(basePaisa, serviceChargeRateBp);

  // 4. VAT, on the discounted base PLUS the service charge.
  const vatRateBp = input.config.vatEnabled ? input.config.vatRateBp : 0;
  const vatPaisa = applyRateBp(basePaisa + serviceChargePaisa, vatRateBp);

  // 5. Whole-rupee rounding, if the restaurant wants it. Paisa coins are not
  //    in circulation, so most do.
  const preRoundedPaisa = basePaisa + serviceChargePaisa + vatPaisa;
  const rounded = input.config.roundGrandTotalToRupee
    ? roundToRupee(preRoundedPaisa)
    : { totalPaisa: preRoundedPaisa, adjustmentPaisa: 0 };

  return {
    lines,
    subtotalPaisa,
    discountType: input.discount.type,
    discountValue: input.discount.type === 'NONE' ? 0 : input.discount.value,
    discountPaisa,
    serviceChargeRateBp,
    serviceChargePaisa,
    vatRateBp,
    vatPaisa,
    roundingAdjustmentPaisa: rounded.adjustmentPaisa,
    grandTotalPaisa: rounded.totalPaisa,
  };
}

/**
 * PERCENT carries basis points and FIXED carries paisa - the schema's meaning,
 * not a new convention. Both are clamped by the caller.
 */
function resolveDiscount(discount: DiscountInput, subtotalPaisa: number): number {
  switch (discount.type) {
    case 'PERCENT':
      return applyRateBp(subtotalPaisa, discount.value);
    case 'FIXED':
      return Math.max(0, discount.value);
    default:
      return 0;
  }
}
