import { syncLoyalty } from '../loyalty/loyalty.service';
import type { NayaroPrismaClient } from '@nayaro/database';
import {
  canSplitByItem,
  itemPaymentShares,
  selectedItemAmount,
  type InvoiceDto,
  type PaymentItemAllocationDto,
} from '@nayaro/shared';
import { withRequestReceipt, type IdempotencyAttempt } from '../../utils/idempotency';
import { claimCustomer, creditBalance } from '../credit/credit.service';
import { ApiError } from '../../utils/apiError';
import { correctionSchema } from '../../utils/correction';
import { INVOICE_SELECT, toInvoiceDto } from '../billing/billing.mapper';
import { recordPaymentSchema, settleInvoiceSchema } from './payments.schema';

/**
 * Payments: money recorded against an issued invoice.
 *
 * THE SHAPE OF THE MODEL, and why it is this way.
 *
 *   Order -> Invoice -> Payment(s)
 *
 * A payment attaches to the DOCUMENT it settles, not loosely to the order.
 * That is what makes "what was this bill paid with?" answerable years later,
 * and it is why `Payment.invoiceId` is non-null.
 *
 * WHAT `PAID` MEANS. An order reaches PAID when its invoice is fully settled,
 * and settlement includes CREDIT - the guest has left, the restaurant carries
 * the receivable, and the table is free for the next customer. That is an
 * operational fact, not an accounting one: CREDIT is emphatically not "cash in
 * the drawer", and a report that adds the two together would be wrong. The
 * customer ledger tracks the debt and later repayments separately from sales.
 *
 * WHAT INVOICE STATUS DOES NOT MEAN. `Invoice.status` is ACTIVE or VOID, and
 * ACTIVE means "a valid, non-voided document" - never "unpaid". Settlement is
 * derived from Payment rows. Overloading that column would leave no way to say
 * "this invoice was voided" about a bill that had been paid.
 */

// ---------------------------------------------------------------------------
// Recording money
// ---------------------------------------------------------------------------

/**
 * Records one payment against an invoice.
 *
 * CONCURRENCY, and the deliberate cost of it. Every payment claims the order's
 * version BEFORE inserting anything. Two terminals settling the same bill at
 * the same instant therefore produce exactly one payment: the loser's claim
 * matches no row, the transaction rolls back, and nothing was inserted - which
 * is the property that matters, because the alternative failure is taking a
 * customer's money twice.
 *
 * The cost is that two *legitimate* concurrent split payments also serialise:
 * one of them gets ORDER_CHANGED and has to be re-entered against the refreshed
 * balance. That is the right trade for V1. Cashiers split a bill by taking one
 * payment then the next, seconds apart; the simultaneous case is rare, and
 * making it convenient would mean giving up the guard that stops an invoice
 * being overpaid.
 */
export async function recordPayment(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
  rawInput: unknown,
  attempt?: IdempotencyAttempt,
): Promise<InvoiceDto> {
  const input = recordPaymentSchema.parse(rawInput);

  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    `payment:${invoiceId}`,
    input,
    attempt,
    async (tx) => {
      const { invoice, order, remainingPaisa } = await loadSettlementContext(
        tx,
        restaurantId,
        invoiceId,
      );

      if (remainingPaisa <= 0) {
        throw new ApiError(409, 'ALREADY_SETTLED', 'This bill has already been settled in full.');
      }
      if (input.amountPaisa > remainingPaisa) {
        // Applies to cash as much as to anything else. A customer handing over
        // more than the bill is not overpaying it - the excess is change, and it
        // belongs in `tenderedPaisa`, never in the amount applied.
        throw new ApiError(
          409,
          'AMOUNT_EXCEEDS_REMAINING',
          'That is more than the amount still owed on this bill.',
        );
      }

      // Claimed BEFORE the insert. This ordering is the whole guarantee: a
      // request that loses the race has written nothing when it finds out.
      await claimOrderVersion(tx, order.id, input.expectedOrderVersion);

      let itemAllocations: PaymentItemAllocationDto[] = [];
      if (input.items) {
        const current = await readInvoice(tx, restaurantId, invoiceId);
        if (!canSplitByItem(current)) {
          throw new ApiError(
            409,
            'ITEM_SPLIT_UNAVAILABLE',
            'This bill has an amount payment. Continue paying by amount, or reverse that payment first.',
          );
        }
        const shares = itemPaymentShares(current);
        itemAllocations = input.items.map((item) => {
          const share = shares.find((row) => row.invoiceLineId === item.invoiceLineId);
          if (!share || item.quantity > share.remainingQuantity) {
            throw new ApiError(
              409,
              'ITEMS_UNAVAILABLE',
              'Those items are not available to pay. Refresh the bill and choose again.',
            );
          }
          return { ...item, amountPaisa: selectedItemAmount(share, item.quantity) };
        });
        if (
          itemAllocations.reduce((sum, item) => sum + item.amountPaisa, 0) !== input.amountPaisa
        ) {
          throw new ApiError(
            409,
            'ITEM_AMOUNT_CHANGED',
            'The amount does not match the selected items, including their share of discounts and charges. Refresh the bill.',
          );
        }
      }

      const customer =
        input.method === 'CREDIT'
          ? await claimCustomer(tx, restaurantId, input.customerId!, undefined, true)
          : null;
      const payment = await tx.payment.create({
        data: {
          restaurantId,
          orderId: order.id,
          invoiceId: invoice.id,
          method: input.method,
          amountPaisa: input.amountPaisa,
          itemAllocations: { create: itemAllocations },
          // Only cash has a tender. Change is derived from the two, never stored.
          tenderedPaisa: input.method === 'CASH' ? (input.tenderedPaisa ?? null) : null,
          reference: input.reference ?? null,
          creditAccountName: customer?.name ?? null,
          customerId: customer?.id ?? null,
          creditAssignedAt: customer ? new Date() : null,
          creditAssignedByStaffId: customer ? staffId : null,
          receivedByStaffId: staffId,
        },
      });

      // Re-read inside the transaction rather than adding to the figure computed
      // above: the payment just written is part of the answer.
      if ((await sumPayments(tx, invoice.id)) >= invoice.grandTotalPaisa) {
        await closeOrder(tx, order.id);
        await syncLoyalty(tx, restaurantId, staffId, invoiceId, `payment:${payment.id}`);
      }
      return readInvoice(tx, restaurantId, invoiceId);
    },
  );
}

/**
 * Settles a bill that is genuinely for nothing.
 *
 * A 100% discount produces a real invoice with real lines and a zero total.
 * There is no payment to record - and the database would refuse one anyway,
 * since `chk_payment_amount` requires `amountPaisa > 0`. Writing a fake zero
 * payment row to close the loop would put a lie in the financial history.
 *
 * Kept separate from issuance on purpose: issuing a document and settling it
 * are two different acts even when the second one is trivial, and a cashier
 * pressing "Settle" is a record that someone decided the bill was finished.
 */
export async function settleZeroTotal(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  invoiceId: string,
  rawInput: unknown,
): Promise<InvoiceDto> {
  const input = settleInvoiceSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    const { invoice, order, totalPaidPaisa } = await loadSettlementContext(
      tx,
      restaurantId,
      invoiceId,
    );

    if (invoice.grandTotalPaisa !== 0 || totalPaidPaisa !== 0) {
      throw new ApiError(
        409,
        'NOT_A_ZERO_BILL',
        'This bill has an amount to pay. Record a payment instead.',
      );
    }

    await claimOrderVersion(tx, order.id, input.expectedOrderVersion);
    await closeOrder(tx, order.id);
  });

  return readInvoice(prisma, restaurantId, invoiceId);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<NayaroPrismaClient['$transaction']>[0]>[0];

/**
 * The invoice, its order and how much is still owed - all read inside the
 * caller's transaction so nothing can change underneath the decision.
 */
async function loadSettlementContext(
  tx: Tx,
  restaurantId: string,
  invoiceId: string,
): Promise<{
  invoice: { id: string; grandTotalPaisa: number };
  order: { id: string };
  totalPaidPaisa: number;
  remainingPaisa: number;
}> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, restaurantId },
    select: {
      id: true,
      status: true,
      grandTotalPaisa: true,
      order: { select: { id: true, status: true } },
    },
  });
  // Scoped lookup: another restaurant's invoice reads as "not found" rather
  // than leaking that it exists.
  if (!invoice) throw new ApiError(404, 'INVOICE_NOT_FOUND', 'That bill no longer exists.');

  if (invoice.status !== 'ACTIVE') {
    throw new ApiError(
      409,
      'INVOICE_VOIDED',
      'This bill was voided. Money cannot be recorded against it.',
    );
  }
  if (invoice.order.status !== 'BILLED') {
    throw new ApiError(
      409,
      invoice.order.status === 'PAID' ? 'ORDER_ALREADY_PAID' : 'ORDER_NOT_BILLED',
      invoice.order.status === 'PAID'
        ? 'This order has already been settled and closed.'
        : 'This order is not ready to take payment.',
    );
  }

  const totalPaidPaisa = await sumPayments(tx, invoice.id);
  return {
    invoice: { id: invoice.id, grandTotalPaisa: invoice.grandTotalPaisa },
    order: { id: invoice.order.id },
    totalPaidPaisa,
    remainingPaisa: invoice.grandTotalPaisa - totalPaidPaisa,
  };
}

/**
 * What has actually been paid. Voided payments are excluded - the same
 * reasoning as voided tickets, a reversal means the money never counted -
 * even though nothing can void a payment yet.
 */
async function sumPayments(tx: Tx, invoiceId: string): Promise<number> {
  const rows = await tx.payment.findMany({
    where: { invoiceId, voidedAt: null },
    select: { amountPaisa: true },
  });
  return rows.reduce((total, row) => total + row.amountPaisa, 0);
}

/**
 * The one path in the product that frees a table.
 *
 * `RestaurantTable.status` is not touched, because it does not exist - table
 * status is derived, and the floor query looks for an order with `closedAt`
 * still null. Closing the order IS releasing the table.
 */
async function closeOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.order.update({
    where: { id: orderId },
    data: { status: 'PAID', closedAt: new Date() },
  });
}

async function claimOrderVersion(tx: Tx, orderId: string, expectedVersion: number): Promise<void> {
  const claimed = await tx.order.updateMany({
    where: { id: orderId, version: expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    throw new ApiError(
      409,
      'ORDER_CHANGED',
      'This bill was updated on another terminal. We have refreshed it - please check the amount still owed and try again.',
    );
  }
}

async function readInvoice(
  prisma: NayaroPrismaClient | Tx,
  restaurantId: string,
  invoiceId: string,
): Promise<InvoiceDto> {
  const row = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId, restaurantId },
    select: INVOICE_SELECT,
  });
  return toInvoiceDto(row);
}

// ---------------------------------------------------------------------------
// Reversing a payment, before the sale closes
// ---------------------------------------------------------------------------

/**
 * Undoes a payment that was recorded wrongly, while the bill is still open.
 *
 * THE CASE THIS EXISTS FOR. A cashier takes Rs 400 against a Rs 1,000 bill and
 * keys it as CASH when the customer actually paid by QR. Nothing is settled,
 * the customer is still standing there, and the only honest fix is to strike
 * the wrong row and record the right one. Voiding leaves the wrong row in
 * place, marked, with a reason - the till at the end of the night has to be
 * explainable, and a payment that simply vanished is not.
 *
 * WHERE IT STOPS, and this boundary is the whole reason the feature is safe.
 * The order must still be BILLED. Once the last payment closed the sale the
 * order is PAID, the table has been released, the customer has gone, and
 * reversing the money is no longer a data correction - it is a refund, with a
 * cash drawer consequence and an accounting entry behind it. Nayaro RMS does
 * records refunds separately, so this path never reopens a settled sale.
 *
 * Nothing here recomputes a stored balance, because there is no stored
 * balance. `sumPayments` and the invoice mapper both count non-voided rows
 * only, so striking the row IS the correction - the remaining amount rises on
 * its own, everywhere, at once.
 */
export async function voidPayment(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  paymentId: string,
  rawInput: unknown,
): Promise<InvoiceDto> {
  const input = correctionSchema.parse(rawInput);

  const invoiceId = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, restaurantId },
      select: {
        id: true,
        invoiceId: true,
        voidedAt: true,
        customerId: true,
        amountPaisa: true,
        order: { select: { id: true, status: true, version: true } },
      },
    });
    // Scoped lookup: another restaurant's payment reads as "not found" rather
    // than leaking that it exists.
    if (!payment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'That payment no longer exists.');

    if (payment.voidedAt !== null) {
      throw new ApiError(409, 'PAYMENT_ALREADY_VOID', 'This payment has already been voided.');
    }

    if (payment.order.status !== 'BILLED') {
      throw new ApiError(
        409,
        payment.order.status === 'PAID' ? 'ORDER_ALREADY_PAID' : 'ORDER_NOT_BILLED',
        payment.order.status === 'PAID'
          ? 'This sale has been settled and closed. Open its bill and record a refund instead.'
          : 'This order is not in a state where a payment can be reversed.',
      );
    }

    /*
     * CONCURRENCY. `voidedAt: null` in the WHERE is the compare-and-swap: two
     * managers pressing Void produce one void and one refusal, and the
     * surviving `voidedAt` is the moment it actually happened rather than
     * whichever duplicate arrived last.
     *
     * The order version claim below is what keeps the settlement arithmetic
     * honest against a concurrent payment. A payment claims the version before
     * it inserts, so a reversal and a new payment cannot interleave into a
     * total that matches neither.
     */
    if (payment.customerId) {
      await claimCustomer(tx, restaurantId, payment.customerId);
      if ((await creditBalance(tx, restaurantId, payment.customerId)) < payment.amountPaisa) {
        throw new ApiError(
          409,
          'CREDIT_ALREADY_REPAID',
          'Reversing this credit would leave the customer overpaid. Reverse the applicable repayment first.',
        );
      }
    }
    const voided = await tx.payment.updateMany({
      where: { id: paymentId, restaurantId, voidedAt: null },
      data: {
        voidedAt: new Date(),
        voidReason: input.reason,
        voidedByStaffId: staffId,
      },
    });
    if (voided.count === 0) {
      throw new ApiError(
        409,
        'PAYMENT_CHANGED',
        'This payment was changed on another terminal. We have refreshed the bill.',
      );
    }

    await claimOrderVersion(tx, payment.order.id, payment.order.version);
    return payment.invoiceId;
  });

  return readInvoice(prisma, restaurantId, invoiceId);
}
