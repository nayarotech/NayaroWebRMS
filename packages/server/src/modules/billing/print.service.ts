import type { NayaroPrismaClient } from '@nayaro/database';
import type { InvoicePrintReceipt } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';

/**
 * Recording that a bill was put on paper.
 *
 * WHY THE DATABASE CARES. A tax invoice is a numbered document, and the second
 * piece of paper carrying invoice #204 must not be indistinguishable from the
 * first. A customer handed an unmarked reprint has a second original; a
 * restaurant handing out two of them has a discrepancy nobody can explain at
 * audit. So every print is a row, `copySequence` 1 is the original, and
 * everything after it is marked as a copy on its face.
 *
 * The `InvoicePrint` table has existed since the Phase 3 schema and had no
 * code behind it until now - which meant the schema described a control the
 * software did not actually apply.
 *
 * WHAT THIS DOES NOT DO: talk to a printer. The renderer owns that, because
 * only it knows what paper is loaded in the machine in front of the cashier.
 * This records the intent and hands back the copy number to print. A row here
 * with nothing in the customer's hand is the expected outcome of an empty roll
 * or an offline printer, and is exactly why `printCount` is a count of
 * attempts rather than a claim about paper.
 */

export async function recordInvoicePrint(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
): Promise<InvoicePrintReceipt> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      // restaurantId from the session, never the request - the same rule as
      // every other route.
      where: { id: invoiceId, restaurantId },
      select: { id: true, status: true, invoiceNumber: true },
    });

    if (!invoice) {
      throw new ApiError(404, 'INVOICE_NOT_FOUND', 'That bill no longer exists.');
    }

    /*
     * A withdrawn invoice is readable forever and printable never.
     *
     * The document still exists - its number stays consumed and a manager
     * reviewing the correction must be able to read it on screen. But putting
     * it on paper produces something that looks exactly like a valid bill for
     * a sale that was undone, and that piece of paper outlives every
     * explanation attached to it.
     */
    if (invoice.status === 'VOID') {
      throw new ApiError(
        409,
        'INVOICE_VOID',
        'This bill was withdrawn and cannot be printed. Issue a new one.',
      );
    }

    /*
     * The next copy number, read inside the transaction that writes it.
     *
     * `@@unique([invoiceId, copySequence])` is the real guarantee: if two
     * terminals somehow reach here together, one of them loses on the unique
     * index rather than both printing "copy 2". SQLite serialises writers, so
     * in practice they cannot.
     */
    const previous = await tx.invoicePrint.count({ where: { invoiceId } });
    const copySequence = previous + 1;

    const print = await tx.invoicePrint.create({
      data: { invoiceId, copySequence, printedByStaffId: staffId },
      select: { printedAt: true, printedByStaff: { select: { id: true, name: true } } },
    });

    return {
      invoiceId,
      copySequence,
      printCount: copySequence,
      // The first one is the document. Every other one has to say so.
      isReprint: copySequence > 1,
      printedAt: print.printedAt.toISOString(),
      printedBy: { id: print.printedByStaff.id, name: print.printedByStaff.name },
    };
  });
}
