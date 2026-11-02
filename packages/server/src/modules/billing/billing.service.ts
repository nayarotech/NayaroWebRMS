import { prepareLoyalty, recordRedemption, reverseRedemption } from '../loyalty/loyalty.service';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { BillingResponse, InvoiceDto, PreBillDto } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { correctionSchema } from '../../utils/correction';
import { resolveBusinessDate } from '../../utils/businessDate';
import { formatNepaliFiscalYear, resolveNepaliFiscalYear } from '../../utils/nepaliCalendar';
import { calculateBill, type BillableLine, type BillingConfig } from './billing.calc';
import { INVOICE_SELECT, toInvoiceDto, toPreBillDto } from './billing.mapper';
import { issueInvoiceSchema, setDiscountSchema } from './billing.schema';
import type { OrderForBillingRow } from './billing.types';

/**
 * Billing: the pre-bill, the working discount, and issuing an invoice.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO PROTECT.
 *
 *   A PRE-BILL is a calculation. Reading one writes nothing, has no number, and
 *   changes as the order changes. It is what the customer looks at while
 *   deciding whether the total is right.
 *
 *   An INVOICE is a document. It has a number from a gapless per-year series,
 *   it is frozen at the moment of issue, and nothing in this service can edit
 *   it afterwards. It is what the restaurant's books are made of.
 *
 * Opening the billing screen must never create the second one. That is why
 * there is no "get or create invoice" anywhere here: reading is `getBilling`,
 * and issuing is a separate, explicit, deliberate operation.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * What the billing screen should show for this order.
 *
 * Exactly one of the two fields comes back. The SERVER decides which, because
 * "an order with an active invoice shows the issued document" is a domain rule,
 * not a rendering preference - a client that got both could show a fresh
 * pre-bill next to an issued invoice and invite someone to bill twice.
 */
export async function getBilling(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  orderId: string,
): Promise<BillingResponse> {
  const [invoice, voidedInvoices] = await Promise.all([
    prisma.invoice.findFirst({
      where: { orderId, restaurantId, status: 'ACTIVE' },
      select: INVOICE_SELECT,
    }),
    /*
     * Withdrawn bills travel alongside whichever state applies. They are the
     * only trace of a correction that a cashier can see: the voided document
     * is not `invoice` - that field means "the live one" - and there is no
     * invoice history screen in V1 for it to hide in.
     */
    prisma.invoice.findMany({
      where: { orderId, restaurantId, status: 'VOID' },
      orderBy: { invoiceNumber: 'asc' },
      select: {
        id: true,
        invoiceNumber: true,
        fiscalYearStartBsYear: true,
        grandTotalPaisa: true,
        issuedAt: true,
        voidedAt: true,
        voidReason: true,
        voidedByStaff: { select: { id: true, name: true } },
      },
    }),
  ]);

  const voided = voidedInvoices.flatMap((row) =>
    row.voidedAt === null || row.voidedByStaff === null
      ? []
      : [
          {
            id: row.id,
            invoiceNumber: row.invoiceNumber,
            fiscalYearLabel: formatNepaliFiscalYear(row.fiscalYearStartBsYear),
            grandTotalPaisa: row.grandTotalPaisa,
            issuedAt: row.issuedAt.toISOString(),
            voidedAt: row.voidedAt.toISOString(),
            reason: row.voidReason ?? '',
            voidedBy: { id: row.voidedByStaff.id, name: row.voidedByStaff.name },
          },
        ],
  );

  if (invoice) {
    return { preBill: null, invoice: toInvoiceDto(invoice), voidedInvoices: voided };
  }
  return {
    preBill: await buildPreBill(prisma, restaurantId, orderId),
    invoice: null,
    voidedInvoices: voided,
  };
}

/** Shared by the read path and the issuance transaction, so they cannot differ. */
async function loadBillingInputs(
  prisma: BillingClient,
  restaurantId: string,
  orderId: string,
): Promise<{
  order: OrderForBillingRow;
  config: BillingConfig;
}> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: {
      id: true,
      orderNumber: true,
      type: true,
      status: true,
      version: true,
      tableId: true,
      table: { select: { name: true } },
      discountType: true,
      discountValue: true,
      loyaltyPointsToRedeem: true,
      loyaltyCustomer: { select: { name: true } },
      items: {
        select: {
          id: true,
          nameSnapshot: true,
          nameNpSnapshot: true,
          promotionSnapshot: true,
          quantity: true,
          unitPricePaisa: true,
          createdAt: true,
          cancellations: { select: { quantity: true } },
        },
      },
      kots: { where: { status: { not: 'VOID' } }, select: { status: true } },
    },
  });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order no longer exists.');

  const settings = await prisma.restaurantSettings.findFirst({
    where: { restaurantId },
    select: {
      vatEnabled: true,
      vatRateBp: true,
      serviceChargeEnabled: true,
      serviceChargeRateBp: true,
      serviceChargeAppliesToTakeaway: true,
      roundGrandTotalToRupee: true,
      abbreviatedInvoiceAuthorized: true,
      abbreviatedInvoiceCeilingPaisa: true,
      businessDayStartsAtMinutes: true,
      timezone: true,
    },
  });
  if (!settings) {
    throw new ApiError(500, 'SETTINGS_MISSING', 'This restaurant has no billing settings.');
  }

  return { order: { ...order, settings }, config: settings };
}

async function buildPreBill(
  prisma: BillingClient,
  restaurantId: string,
  orderId: string,
): Promise<PreBillDto> {
  const { order, config } = await loadBillingInputs(prisma, restaurantId, orderId);
  const bill = calculateBill({
    lines: toBillableLines(order),
    orderType: order.type,
    discount: { type: order.discountType, value: order.discountValue },
    config,
  });
  return toPreBillDto(order, bill);
}

/**
 * BILLABLE QUANTITY: ordered minus cancelled.
 *
 * There is no cancellation UI yet, so every order today has no cancellations
 * and this reduces to `quantity`. It is written the correct way NOW because the
 * alternative - billing `quantity` and "fixing it later" - means every invoice
 * issued before the fix silently overcharged someone.
 */
function toBillableLines(order: OrderForBillingRow): BillableLine[] {
  return [...order.items]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((item) => ({
      orderItemId: item.id,
      name: item.nameSnapshot,
      nameNp: item.nameNpSnapshot,
      quantity: item.quantity,
      cancelledQuantity: item.cancellations.reduce(
        (total: number, cancellation) => total + cancellation.quantity,
        0,
      ),
      unitPricePaisa: item.unitPricePaisa,
      promotionSnapshot: item.promotionSnapshot,
    }));
}

// ---------------------------------------------------------------------------
// Working discount
// ---------------------------------------------------------------------------

/**
 * Sets the discount held on the Order. This is a PRE-BILL input, not money
 * that has been charged - the figure that counts is the one frozen onto the
 * invoice at issue.
 *
 * `discountApprovedByStaffId` records who applied it. Only OWNER and MANAGER
 * reach this function (the route enforces it), so the column means exactly what
 * it says: a person with the authority to give money away did.
 */
export async function setDiscount(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  orderId: string,
  rawInput: unknown,
): Promise<PreBillDto> {
  const input = setDiscountSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, restaurantId },
      select: { status: true, loyaltyPointsToRedeem: true },
    });
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order no longer exists.');
    assertBillable(order.status);
    if (order.loyaltyPointsToRedeem > 0)
      throw new ApiError(
        409,
        'LOYALTY_REWARD_PRESENT',
        'Clear the loyalty reward before applying a manual bill discount.',
      );

    // A billed order's discount is settled. Checked separately from status
    // because the two are meant to agree and a disagreement should fail safe.
    if ((await tx.invoice.count({ where: { orderId, status: 'ACTIVE' } })) > 0) {
      throw alreadyBilled();
    }

    await claimOrderVersion(tx, orderId, input.expectedVersion);

    const isNone = input.discountType === 'NONE';
    await tx.order.update({
      where: { id: orderId },
      data: {
        discountType: input.discountType,
        discountValue: isNone ? 0 : (input.discountValue ?? 0),
        discountApprovedByStaffId: isNone ? null : staffId,
      },
    });
  });

  return buildPreBill(prisma, restaurantId, orderId);
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/**
 * Issues the invoice. The most consequential transaction in the product.
 *
 * ORDER OF OPERATIONS, and why it is this order:
 *
 *   1. validate everything that can fail
 *   2. calculate the authoritative total from the order's CURRENT state
 *   3. only then allocate an invoice number
 *   4. write the invoice and its frozen lines
 *   5. move the order to BILLED
 *
 * The number is allocated last among the things that can fail because an
 * invoice series must not have holes in it. Anything that throws before step 3
 * consumes nothing; anything that throws after it rolls the counter back with
 * the rest of the transaction. Either way the next invoice takes the number
 * this one would have.
 *
 * The totals are recalculated here rather than trusted from whatever pre-bill
 * the client last saw. Between looking at a screen and pressing Issue, another
 * terminal can add a dish - and the document must state what is actually owed.
 * The version check is what tells the cashier that happened.
 */
export async function issueInvoice(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  orderId: string,
  rawInput: unknown,
): Promise<InvoiceDto> {
  const input = issueInvoiceSchema.parse(rawInput);
  const invoiceType = input.invoiceType ?? 'STANDARD';

  const invoiceId = await prisma.$transaction(async (tx) => {
    const { order, config } = await loadBillingInputs(tx, restaurantId, orderId);
    assertBillable(order.status);
    // Checked before the generic status test so the message says what actually
    // happened. This is also the path a losing terminal takes when two people
    // press Issue at once and the winner commits first.
    if (order.status === 'BILLED') throw alreadyBilled();
    if (order.status !== 'OPEN') {
      throw new ApiError(
        409,
        'ORDER_NOT_OPEN',
        order.status === 'DRAFT'
          ? 'Send this order to the kitchen before billing it.'
          : 'This order cannot be billed in its current state.',
      );
    }
    if ((await tx.invoice.count({ where: { orderId, status: 'ACTIVE' } })) > 0) {
      throw alreadyBilled();
    }

    await claimOrderVersion(tx, orderId, input.expectedVersion);

    const bill = calculateBill({
      lines: toBillableLines(order),
      orderType: order.type,
      discount: { type: order.discountType, value: order.discountValue },
      config,
    });

    // An invoice with no lines is not a document, it is a mistake. The database
    // would refuse a zero-quantity line anyway; this refuses the whole thing
    // with something a cashier can act on.
    if (bill.lines.length === 0) {
      throw new ApiError(409, 'NOTHING_TO_BILL', 'There is nothing to bill on this order.');
    }

    if (invoiceType === 'ABBREVIATED') {
      assertAbbreviatedAllowed(
        bill.grandTotalPaisa,
        order.settings.abbreviatedInvoiceAuthorized,
        order.settings.abbreviatedInvoiceCeilingPaisa,
      );
    }

    const loyaltySnapshot = await prepareLoyalty(tx, restaurantId, orderId, bill.subtotalPaisa);
    const seller = await tx.restaurant.findFirstOrThrow({
      where: { id: restaurantId },
      select: { name: true, address: true, panNumber: true },
    });
    const businessDate = resolveBusinessDate(new Date(), order.settings.businessDayStartsAtMinutes, order.settings.timezone);
    const fiscalYearStartBsYear = resolveNepaliFiscalYear(businessDate);
    const invoiceNumber = await allocateInvoiceNumber(
      tx,
      restaurantId,
      invoiceType,
      fiscalYearStartBsYear,
    );

    const created = await tx.invoice.create({
      data: {
        restaurantId,
        orderId,
        loyaltySnapshot,
        invoiceType,
        invoiceNumber,
        fiscalYearStartBsYear,
        status: 'ACTIVE',
        issuedByStaffId: staffId,
        businessDate,
        buyerName: input.buyerName ?? null,
        buyerPan: input.buyerPan ?? null,
        buyerAddress: input.buyerAddress ?? null,
        // SELLER identity, frozen here with the money. Without this a reprint
        // would show the restaurant's details as they are TODAY, so correcting
        // a PAN typo would silently rewrite who every past invoice says issued
        // it. A tax document has to reproduce itself.
        sellerName: seller.name,
        sellerAddress: seller.address,
        sellerPan: seller.panNumber,
        // Frozen money. Every figure the document shows, stored, so rendering
        // it later needs no menu, no order and no settings.
        subtotalPaisa: bill.subtotalPaisa,
        discountType: bill.discountType,
        discountValue: bill.discountValue,
        discountPaisa: bill.discountPaisa,
        serviceChargeRateBp: bill.serviceChargeRateBp,
        serviceChargePaisa: bill.serviceChargePaisa,
        vatRateBp: bill.vatRateBp,
        vatPaisa: bill.vatPaisa,
        roundingAdjustmentPaisa: bill.roundingAdjustmentPaisa,
        grandTotalPaisa: bill.grandTotalPaisa,
        lines: {
          create: bill.lines.map((line, index) => ({
            lineNumber: index + 1,
            // Provenance only. The snapshots beside it are what the document
            // says, and they survive the OrderItem being edited or removed.
            orderItemId: line.orderItemId,
            description: line.name,
            descriptionNp: line.nameNp,
            promotionSnapshot: line.promotionSnapshot ?? null,
            quantity: line.billableQuantity,
            unitPricePaisa: line.unitPricePaisa,
            lineTotalPaisa: line.lineTotalPaisa,
          })),
        },
      },
      select: { id: true },
    });

    await recordRedemption(tx, restaurantId, staffId, created.id, loyaltySnapshot);

    // The order is now a bill awaiting settlement. Items and discount are
    // closed to editing from this moment (the order service refuses BILLED),
    // and the floor turns AWAITING_PAYMENT because an ACTIVE invoice outranks
    // every kitchen state.
    await tx.order.update({ where: { id: orderId }, data: { status: 'BILLED' } });

    return created.id;
  });

  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    select: INVOICE_SELECT,
  });
  return toInvoiceDto(invoice);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type BillingClient = Pick<NayaroPrismaClient, 'order' | 'restaurantSettings' | 'invoice'>;
type Tx = Parameters<Parameters<NayaroPrismaClient['$transaction']>[0]>[0];

/**
 * Same compare-and-swap the order service uses. Billing is not exempt: a
 * discount applied against a stale view of the order would price food nobody
 * has seen.
 */
async function claimOrderVersion(tx: Tx, orderId: string, expectedVersion: number): Promise<void> {
  const claimed = await tx.order.updateMany({
    where: { id: orderId, version: expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    throw new ApiError(
      409,
      'ORDER_CHANGED',
      'This order was changed on another terminal. We have refreshed it - please check the total and try again.',
    );
  }
}

function assertBillable(status: string): void {
  if (status === 'PAID' || status === 'VOID') {
    throw new ApiError(409, 'ORDER_CLOSED', 'This order is closed and can no longer be billed.');
  }
}

function alreadyBilled(): ApiError {
  return new ApiError(
    409,
    'ORDER_ALREADY_BILLED',
    'A bill has already been issued for this order.',
  );
}

/**
 * ABBREVIATED is never chosen for the customer. Two independent conditions have
 * to hold, and both produce their own message because they are fixed in
 * different places: one in Settings, one by charging less.
 */
function assertAbbreviatedAllowed(
  grandTotalPaisa: number,
  authorized: boolean,
  ceilingPaisa: number,
): void {
  if (!authorized) {
    throw new ApiError(
      409,
      'ABBREVIATED_NOT_AUTHORIZED',
      'This restaurant is not set up to issue abbreviated tax invoices.',
    );
  }
  if (grandTotalPaisa > ceilingPaisa) {
    throw new ApiError(
      409,
      'ABBREVIATED_ABOVE_CEILING',
      'This bill is above the limit for an abbreviated tax invoice. Issue a standard tax invoice instead.',
    );
  }
}

/**
 * Invoice numbers, one series per (type, fiscal year).
 *
 *   INVOICE:STANDARD:2082
 *   INVOICE:ABBREVIATED:2082
 *
 * Allocated by incrementing inside the caller's transaction, exactly as order
 * and KOT numbers are, so two simultaneous issues cannot be handed the same
 * number and a rolled-back issue consumes none.
 */
async function allocateInvoiceNumber(
  tx: Tx,
  restaurantId: string,
  invoiceType: string,
  fiscalYearStartBsYear: number,
): Promise<number> {
  const name = `INVOICE:${invoiceType}:${String(fiscalYearStartBsYear)}`;
  const counter = await tx.restaurantCounter.upsert({
    where: { restaurantId_name: { restaurantId, name } },
    create: { restaurantId, name, nextValue: 2 },
    update: { nextValue: { increment: 1 } },
    select: { nextValue: true },
  });
  return counter.nextValue - 1;
}

// ---------------------------------------------------------------------------
// Voiding an unpaid invoice
// ---------------------------------------------------------------------------

/**
 * Withdraws an issued bill that nobody has paid, and reopens its order.
 *
 * WHAT IS AND IS NOT REVERSIBLE HERE. This is the correction for "we billed
 * the wrong thing" - a mis-keyed discount, a dish on the wrong table, an item
 * the customer had already cancelled. It is NOT a refund. The moment real
 * money has been recorded against an invoice, undoing the document is an
 * accounting reversal with a cash consequence, and Nayaro RMS does not do
 * that yet. So the gate is absolute: no live payment may exist. If one does,
 * void the payment first - which is itself only possible before the sale
 * closed - or the correction is out of reach and stays that way honestly.
 *
 * THE NUMBER IS GONE FOREVER. Voiding does not free the invoice number for
 * reuse and nothing here touches the counter. Invoice #12 stays #12, VOID,
 * with its lines and its totals intact; the replacement is #13. A series with
 * a reused number is a series nobody can audit, and the whole point of the
 * counter is that it can be.
 *
 * WHAT THE ORDER DOES. It goes BILLED -> OPEN, which is what makes the reissue
 * path work: items can be edited or cancelled again, the discount can be
 * changed, and issuing produces a fresh document. The partial unique index
 * `uq_invoice_active_per_order` keeps the invariant through all of it - zero
 * ACTIVE invoices after the void, exactly one after the reissue.
 */
export async function voidInvoice(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
  rawInput: unknown,
): Promise<InvoiceDto> {
  const input = correctionSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, restaurantId },
      select: {
        id: true,
        status: true,
        order: { select: { id: true, status: true, version: true } },
      },
    });
    // Scoped lookup: another restaurant's invoice reads as "not found" rather
    // than leaking that it exists.
    if (!invoice) throw new ApiError(404, 'INVOICE_NOT_FOUND', 'That bill no longer exists.');

    if (invoice.status !== 'ACTIVE') {
      throw new ApiError(409, 'INVOICE_ALREADY_VOID', 'This bill has already been voided.');
    }

    if (invoice.order.status !== 'BILLED') {
      throw new ApiError(
        409,
        invoice.order.status === 'PAID' ? 'ORDER_ALREADY_PAID' : 'ORDER_NOT_BILLED',
        invoice.order.status === 'PAID'
          ? 'This sale has been settled and closed. Correcting it needs a refund, which Nayaro RMS does not do yet.'
          : 'This order is not in a state where its bill can be voided.',
      );
    }

    /*
     * Live payments only. A payment that has itself been voided is history,
     * not money, and must not block a correction - otherwise the sequence
     * "void the wrong payment, then void the wrong bill" would dead-end one
     * step from the end.
     */
    const paid = await tx.payment.count({ where: { invoiceId, voidedAt: null } });
    if (paid > 0) {
      throw new ApiError(
        409,
        'INVOICE_HAS_PAYMENTS',
        'Money has been recorded against this bill. Void the payment first, then void the bill.',
      );
    }

    /*
     * CONCURRENCY, and the race that matters most in this phase: a manager
     * voiding the bill while a cashier takes money for it. Two conditional
     * updates decide it, and both must match.
     *
     * The invoice CAS refuses a second void. The order CAS - on the version
     * read at the top of this transaction - is what excludes the payment: a
     * payment claims that same version before it inserts anything, so whichever
     * commits first moves it and the other finds nothing to match. The two
     * outcomes are "invoice VOID, no payment" and "payment recorded, void
     * refused". The one outcome that cannot happen is both.
     */
    const voided = await tx.invoice.updateMany({
      where: { id: invoiceId, restaurantId, status: 'ACTIVE' },
      data: {
        status: 'VOID',
        voidedAt: new Date(),
        voidReason: input.reason,
        voidedByStaffId: staffId,
      },
    });
    if (voided.count === 0) {
      throw new ApiError(
        409,
        'INVOICE_CHANGED',
        'This bill was changed on another terminal. We have refreshed it - please check it and try again.',
      );
    }

    const reopened = await tx.order.updateMany({
      where: { id: invoice.order.id, status: 'BILLED', version: invoice.order.version },
      data: { status: 'OPEN', version: { increment: 1 } },
    });
    if (reopened.count === 0) {
      throw new ApiError(
        409,
        'ORDER_CHANGED',
        'This order was changed on another terminal. We have refreshed it - please check it and try again.',
      );
    }
    await reverseRedemption(tx, restaurantId, staffId, invoiceId);
  });

  const row = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    select: INVOICE_SELECT,
  });
  return toInvoiceDto(row);
}
