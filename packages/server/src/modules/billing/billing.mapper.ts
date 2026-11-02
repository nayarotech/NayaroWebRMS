import { loyaltySummary } from '../loyalty/loyalty.service';
import { promotionSummary } from '../offers/offers.service';
import type { InvoiceDto, PreBillDto } from '@nayaro/shared';
import { formatNepaliFiscalYear } from '../../utils/nepaliCalendar';
import type { CalculatedBill } from './billing.calc';
import type { InvoiceRow, OrderForBillingRow } from './billing.types';

/**
 * Every column needed to render an issued invoice.
 *
 * The point of this list is what is NOT in it: no MenuItem, no OrderItem, no
 * RestaurantSettings. An invoice reproduces itself. If reprinting a document
 * from last Ashadh needed today's menu, the reprint would be a different bill.
 */
export const INVOICE_SELECT = {
  loyaltySnapshot: true,
  loyaltyEntries: { select: { kind: true, deltaPoints: true } },
  id: true,
  invoiceType: true,
  invoiceNumber: true,
  fiscalYearStartBsYear: true,
  status: true,
  issuedAt: true,
  businessDate: true,
  buyerName: true,
  buyerPan: true,
  buyerAddress: true,
  sellerName: true,
  sellerAddress: true,
  sellerPan: true,
  subtotalPaisa: true,
  discountType: true,
  discountValue: true,
  discountPaisa: true,
  serviceChargeRateBp: true,
  serviceChargePaisa: true,
  vatRateBp: true,
  vatPaisa: true,
  roundingAdjustmentPaisa: true,
  grandTotalPaisa: true,
  voidedAt: true,
  voidReason: true,
  voidedByStaff: { select: { id: true, name: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      type: true,
      version: true,
      status: true,
      table: { select: { name: true } },
    },
  },
  /*
   * Payments against this invoice, VOIDED ONES INCLUDED.
   *
   * They are shown but not counted. A reversed payment contributes nothing to
   * the settlement - the money never counted, the same way a voided ticket
   * never went to the kitchen - but dropping the row from the screen would
   * leave a cashier unable to explain why the bill they part-settled ten
   * minutes ago now shows nothing paid. The exclusion happens in the
   * arithmetic below, once, where it can be seen.
   */
  payments: {
    select: {
      id: true,
      method: true,
      amountPaisa: true,
      refunds: {
        include: { staff: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      },
      itemAllocations: {
        select: { invoiceLineId: true, quantity: true, amountPaisa: true },
        orderBy: { invoiceLine: { lineNumber: 'asc' } },
      },
      tenderedPaisa: true,
      reference: true,
      creditAccountName: true,
      customerId: true,
      createdAt: true,
      receivedByStaff: { select: { id: true, name: true } },
      voidedAt: true,
      voidReason: true,
      voidedByStaff: { select: { id: true, name: true } },
    },
  },
  lines: {
    select: {
      id: true,
      lineNumber: true,
      description: true,
      descriptionNp: true,
      promotionSnapshot: true,
      quantity: true,
      unitPricePaisa: true,
      lineTotalPaisa: true,
    },
  },
  /*
   * How many times this has been printed. A count rather than the rows: the
   * screen needs to know "has this been printed, and is the next one a copy",
   * and shipping every print record to answer that would be a list nobody
   * reads growing on a document that never changes.
   */
  _count: { select: { prints: true } },
} as const;

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  const payments = [...row.payments]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((payment) => ({
      id: payment.id,
      method: payment.method,
      amountPaisa: payment.amountPaisa,
      itemAllocations: payment.itemAllocations,
      refunds: payment.refunds.map((refund) => ({
        ...refund,
        createdAt: refund.createdAt.toISOString(),
      })),
      tenderedPaisa: payment.tenderedPaisa,
      // Derived, never stored: change is a fact about two other numbers.
      changePaisa: Math.max(
        0,
        (payment.tenderedPaisa ?? payment.amountPaisa) - payment.amountPaisa,
      ),
      reference: payment.reference,
      creditAccountName: payment.creditAccountName,
      customerId: payment.customerId,
      createdAt: payment.createdAt.toISOString(),
      receivedBy: { id: payment.receivedByStaff.id, name: payment.receivedByStaff.name },
      void:
        payment.voidedAt === null || payment.voidedByStaff === null
          ? null
          : {
              voidedAt: payment.voidedAt.toISOString(),
              reason: payment.voidReason ?? '',
              voidedBy: { id: payment.voidedByStaff.id, name: payment.voidedByStaff.name },
            },
    }));

  // THE ONE PLACE voided payments are excluded. Every settlement figure below
  // is derived from this sum, so a reversal cannot half-apply.
  const totalPaidPaisa = payments
    .filter((payment) => payment.void === null)
    .reduce((total, payment) => total + payment.amountPaisa, 0);
  const remainingPaisa = Math.max(0, row.grandTotalPaisa - totalPaidPaisa);

  return {
    id: row.id,
    loyalty: loyaltySummary(row.loyaltySnapshot, row.loyaltyEntries),
    invoiceType: row.invoiceType,
    invoiceNumber: row.invoiceNumber,
    fiscalYearStartBsYear: row.fiscalYearStartBsYear,
    // Display form only, computed here. One fiscal year has exactly one stored
    // representation - the integer - and "2082/83" never goes into a column.
    fiscalYearLabel: formatNepaliFiscalYear(row.fiscalYearStartBsYear),
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    businessDate: row.businessDate,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    orderType: row.order.type,
    tableName: row.order.table?.name ?? null,
    orderVersion: row.order.version,
    seller: {
      name: row.sellerName,
      address: row.sellerAddress,
      pan: row.sellerPan,
    },
    buyer: {
      name: row.buyerName,
      pan: row.buyerPan,
      address: row.buyerAddress,
    },
    lines: [...row.lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        description: line.description,
        descriptionNp: line.descriptionNp,
        promotion: promotionSummary(line.promotionSnapshot),
        quantity: line.quantity,
        unitPricePaisa: line.unitPricePaisa,
        lineTotalPaisa: line.lineTotalPaisa,
      })),
    subtotalPaisa: row.subtotalPaisa,
    discount: {
      type: row.discountType,
      value: row.discountValue,
      amountPaisa: row.discountPaisa,
    },
    // `enabled` is derived from the EFFECTIVE rate that was frozen, not from
    // today's settings: turning VAT on next month must not make last month's
    // invoices claim they charged it.
    serviceCharge: {
      enabled: row.serviceChargeRateBp > 0,
      rateBp: row.serviceChargeRateBp,
      amountPaisa: row.serviceChargePaisa,
    },
    vat: {
      enabled: row.vatRateBp > 0,
      rateBp: row.vatRateBp,
      amountPaisa: row.vatPaisa,
    },
    roundingAdjustmentPaisa: row.roundingAdjustmentPaisa,
    grandTotalPaisa: row.grandTotalPaisa,
    printCount: row._count.prints,
    settlement: {
      payments,
      totalPaidPaisa,
      remainingPaisa,
      // A zero-total bill is UNPAID until someone settles it - the order's
      // closure is what says it is finished, not the arithmetic being trivial.
      status:
        row.grandTotalPaisa === 0 && row.order.status === 'PAID'
          ? 'PAID'
          : totalPaidPaisa === 0
            ? 'UNPAID'
            : remainingPaisa === 0
              ? 'PAID'
              : 'PARTIAL',
    },
    void:
      row.voidedAt === null || row.voidedByStaff === null
        ? null
        : {
            voidedAt: row.voidedAt.toISOString(),
            reason: row.voidReason ?? '',
            voidedBy: { id: row.voidedByStaff.id, name: row.voidedByStaff.name },
          },
  };
}

export function toPreBillDto(order: OrderForBillingRow, bill: CalculatedBill): PreBillDto {
  const pending = order.kots.filter(
    (kot) => kot.status === 'NEW' || kot.status === 'PREPARING' || kot.status === 'READY',
  ).length;

  const abbreviatedAvailable =
    order.settings.abbreviatedInvoiceAuthorized &&
    bill.grandTotalPaisa <= order.settings.abbreviatedInvoiceCeilingPaisa;

  return {
    loyalty: order.loyaltyCustomer
      ? {
          customerName: order.loyaltyCustomer.name,
          pointsRedeemed: order.loyaltyPointsToRedeem,
          redemptionPaisa: order.loyaltyPointsToRedeem > 0 ? order.discountValue : 0,
          pointsEarned: 0,
          pointsReturned: 0,
        }
      : null,
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderType: order.type,
    tableName: order.table?.name ?? null,
    orderVersion: order.version,
    lines: bill.lines.map((line) => ({
      orderItemId: line.orderItemId,
      name: line.name,
      nameNp: line.nameNp,
      promotion: promotionSummary(line.promotionSnapshot ?? null),
      quantity: line.quantity,
      cancelledQuantity: line.cancelledQuantity,
      billableQuantity: line.billableQuantity,
      unitPricePaisa: line.unitPricePaisa,
      lineTotalPaisa: line.lineTotalPaisa,
    })),
    subtotalPaisa: bill.subtotalPaisa,
    discount: {
      type: bill.discountType,
      value: bill.discountValue,
      amountPaisa: bill.discountPaisa,
    },
    serviceCharge: {
      enabled: bill.serviceChargeRateBp > 0,
      rateBp: bill.serviceChargeRateBp,
      amountPaisa: bill.serviceChargePaisa,
    },
    vat: {
      enabled: bill.vatRateBp > 0,
      rateBp: bill.vatRateBp,
      amountPaisa: bill.vatPaisa,
    },
    roundingAdjustmentPaisa: bill.roundingAdjustmentPaisa,
    grandTotalPaisa: bill.grandTotalPaisa,
    // Advisory, never blocking. Restaurants bill while food is still coming,
    // and a kitchen that forgot to tap "served" must not hold up a customer
    // who is standing at the counter with their wallet out.
    kitchenWarning:
      pending === 0
        ? null
        : `${String(pending)} kitchen ${pending === 1 ? 'ticket is' : 'tickets are'} still open. You can still bill this order.`,
    abbreviated: {
      authorized: order.settings.abbreviatedInvoiceAuthorized,
      ceilingPaisa: order.settings.abbreviatedInvoiceCeilingPaisa,
      available: abbreviatedAvailable,
      unavailableReason: !order.settings.abbreviatedInvoiceAuthorized
        ? 'This restaurant is not set up to issue abbreviated tax invoices.'
        : abbreviatedAvailable
          ? null
          : 'This bill is above the limit for an abbreviated tax invoice.',
    },
  };
}
