import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  InvoiceListResponse,
  InvoiceSummaryDto,
  PaymentMethod,
  PaymentStatus,
} from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { resolveBusinessDate } from '../../utils/businessDate';
import { formatNepaliFiscalYear } from '../../utils/nepaliCalendar';

/**
 * Invoice history: "find me that bill".
 *
 * READ ONLY, and deliberately thin. A row here is a pointer to a document, not
 * the document - opening one goes through the order's billing read, which is
 * the single place that knows how an invoice is rendered, reprinted, settled
 * or voided. A second rendering path would be a second set of rules.
 *
 * Addressed by BUSINESS DATE, not by issuedAt. A bill issued at 01:30 belongs
 * to the previous night's trade, and the owner looking for "last night's
 * bills" means the trading day, not the calendar one.
 */

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.');

export const listInvoicesQuerySchema = z
  .object({
    from: businessDate.optional(),
    to: businessDate.optional(),
    status: z.enum(['ALL', 'ACTIVE', 'VOID']).optional(),
    q: z.string().trim().max(60).optional(),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'The start date must be on or before the end date.',
  });

type InvoiceWhere = NonNullable<
  NonNullable<Parameters<NayaroPrismaClient['invoice']['findMany']>[0]>['where']
>;

/** Wide enough for a month's books; narrow enough that nobody scans a year by accident. */
const MAX_RANGE_DAYS = 93;
/** Rows returned. Totals are computed over every match regardless. */
const MAX_ROWS = 500;

export async function listInvoices(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawQuery: unknown,
): Promise<InvoiceListResponse> {
  const query = listInvoicesQuerySchema.parse(rawQuery);

  let { from, to } = query;
  if (from === undefined || to === undefined) {
    const settings = await prisma.restaurantSettings.findFirst({
      where: { restaurantId },
      select: { businessDayStartsAtMinutes: true, timezone: true },
    });
    const today = resolveBusinessDate(new Date(), settings?.businessDayStartsAtMinutes ?? 240, settings?.timezone);
    from ??= to ?? today;
    to ??= from > today ? from : today;
  }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    throw new ApiError(
      400,
      'RANGE_TOO_WIDE',
      `Search at most ${String(MAX_RANGE_DAYS)} days at a time.`,
    );
  }

  // String comparison is date comparison for zero-padded YYYY-MM-DD.
  const where: InvoiceWhere = {
    restaurantId,
    businessDate: { gte: from, lte: to },
    ...(query.status === undefined || query.status === 'ALL' ? {} : { status: query.status }),
    ...searchFilter(query.q),
  };

  const [rows, matched, statusCounts, billed, paid, refunded] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: MAX_ROWS,
      select: {
        id: true,
        invoiceType: true,
        invoiceNumber: true,
        fiscalYearStartBsYear: true,
        status: true,
        issuedAt: true,
        businessDate: true,
        issuedByStaff: { select: { id: true, name: true } },
        buyerName: true,
        buyerPan: true,
        grandTotalPaisa: true,
        order: {
          select: { id: true, orderNumber: true, type: true, table: { select: { name: true } } },
        },
        payments: {
          where: { voidedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { method: true, amountPaisa: true, refunds: { select: { amountPaisa: true } } },
        },
        _count: { select: { prints: true } },
      },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.invoice.aggregate({
      where: { ...where, status: 'ACTIVE' },
      _sum: { grandTotalPaisa: true },
    }),
    // Money against live documents only. A payment on a voided invoice cannot
    // exist (the void refuses it), but the filter says so rather than assuming.
    prisma.payment.aggregate({
      where: { voidedAt: null, invoice: { ...where, status: 'ACTIVE' } },
      _sum: { amountPaisa: true },
    }),
    prisma.paymentRefund.aggregate({
      where: { restaurantId, payment: { invoice: { ...where, status: 'ACTIVE' } } },
      _sum: { amountPaisa: true },
    }),
  ]);

  const countOf = (status: 'ACTIVE' | 'VOID'): number =>
    statusCounts.find((group) => group.status === status)?._count._all ?? 0;
  const billedPaisa = billed._sum.grandTotalPaisa ?? 0;
  const paidPaisa = paid._sum.amountPaisa ?? 0;

  return {
    from,
    to,
    invoices: rows.map((row): InvoiceSummaryDto => {
      const totalPaidPaisa = row.payments.reduce((sum, p) => sum + p.amountPaisa, 0);
      const remaining = Math.max(0, row.grandTotalPaisa - totalPaidPaisa);
      const settlementStatus: PaymentStatus =
        totalPaidPaisa === 0 ? 'UNPAID' : remaining === 0 ? 'PAID' : 'PARTIAL';
      return {
        refundedPaisa: row.payments.reduce(
          (sum, payment) =>
            sum + payment.refunds.reduce((total, refund) => total + refund.amountPaisa, 0),
          0,
        ),
        id: row.id,
        invoiceType: row.invoiceType,
        invoiceNumber: row.invoiceNumber,
        fiscalYearLabel: formatNepaliFiscalYear(row.fiscalYearStartBsYear),
        status: row.status,
        issuedAt: row.issuedAt.toISOString(),
        businessDate: row.businessDate,
        issuedBy: { id: row.issuedByStaff.id, name: row.issuedByStaff.name },
        orderId: row.order.id,
        orderNumber: row.order.orderNumber,
        orderType: row.order.type,
        tableName: row.order.table?.name ?? null,
        buyerName: row.buyerName,
        buyerPan: row.buyerPan,
        grandTotalPaisa: row.grandTotalPaisa,
        totalPaidPaisa,
        settlementStatus,
        paymentMethods: [...new Set<PaymentMethod>(row.payments.map((p) => p.method))],
        printCount: row._count.prints,
      };
    }),
    totals: {
      refundedPaisa: refunded._sum.amountPaisa ?? 0,
      activeCount: countOf('ACTIVE'),
      voidCount: countOf('VOID'),
      billedPaisa,
      paidPaisa,
      outstandingPaisa: Math.max(0, billedPaisa - paidPaisa),
    },
    truncated: matched > rows.length,
  };
}

/**
 * Free-text search over what a person at the counter actually says: an invoice
 * or order number, a table, a buyer's name or PAN. SQLite's LIKE is already
 * case-insensitive for ASCII, which covers names typed in English.
 */
function searchFilter(q: string | undefined): InvoiceWhere {
  if (q === undefined || q.length === 0) return {};
  const text = [
    { buyerName: { contains: q } },
    { buyerPan: { contains: q } },
    { order: { table: { name: { contains: q } } } },
  ];
  // "#42" and "42" mean the same thing to a cashier.
  const digits = /^#?(\d{1,9})$/.exec(q)?.[1];
  if (digits === undefined) return { OR: text };
  const n = Number(digits);
  return { OR: [...text, { invoiceNumber: n }, { order: { orderNumber: n } }] };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
