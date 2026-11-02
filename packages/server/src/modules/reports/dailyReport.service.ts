import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  CategorySalesDto,
  DailyReportResponse,
  ItemSalesDto,
  MethodTotalDto,
  OrderType,
  PaymentMethod,
  StaffSalesDto,
} from '@nayaro/shared';
import { resolveBusinessDate } from '../../utils/businessDate';
import { formatNepaliFiscalYear } from '../../utils/nepaliCalendar';
import { creditCollections } from '../credit/credit.service';
import { listShiftsForDay } from '../drawer/drawer.service';
import { refundSummary } from '../refunds/refunds.routes';
import { expenseSummary } from '../expenses/expenses.routes';

/**
 * The end-of-day (Z) report for one business date.
 *
 * Built ENTIRELY from frozen documents. Sales come from ACTIVE invoices and
 * their lines, never from orders or today's menu: an invoice states what was
 * charged, and a report that re-derived it would disagree with the bills the
 * customers took home the first time anybody changed a price.
 *
 * Every correction made that day is listed with who made it and why. That
 * section is the point of the report as much as the totals are - an owner who
 * reads "3 bills voided by the same person" learns something the sales figure
 * would never tell them.
 *
 * Everything is attributed by BUSINESS DATE: a document's own `businessDate`
 * where it has one, its order's otherwise.
 */

export const dailyReportQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.')
    .optional(),
});

const METHOD_ORDER: readonly PaymentMethod[] = ['CASH', 'QR', 'CARD', 'CREDIT'];
const ORDER_TYPES: readonly OrderType[] = ['DINE_IN', 'TAKEAWAY'];

export async function getDailyReport(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawQuery: unknown,
): Promise<DailyReportResponse> {
  const query = dailyReportQuerySchema.parse(rawQuery);
  let businessDate = query.date;
  if (businessDate === undefined) {
    const settings = await prisma.restaurantSettings.findFirst({
      where: { restaurantId },
      select: { businessDayStartsAtMinutes: true, timezone: true },
    });
    businessDate = resolveBusinessDate(new Date(), settings?.businessDayStartsAtMinutes ?? 240, settings?.timezone);
  }

  const staffRef = { select: { id: true, name: true } } as const;

  const [invoices, voidedInvoices, voidedPayments, cancellations, voidedKots, unbilled, shifts] =
    await Promise.all([
      prisma.invoice.findMany({
        where: { restaurantId, businessDate, status: 'ACTIVE' },
        orderBy: { invoiceNumber: 'asc' },
        select: {
          invoiceNumber: true,
          fiscalYearStartBsYear: true,
          subtotalPaisa: true,
          discountPaisa: true,
          serviceChargePaisa: true,
          vatPaisa: true,
          roundingAdjustmentPaisa: true,
          grandTotalPaisa: true,
          issuedByStaff: staffRef,
          order: {
            select: { id: true, type: true, discountApprovedByStaff: staffRef },
          },
          payments: {
            where: { voidedAt: null },
            select: { method: true, amountPaisa: true },
          },
          lines: {
            select: {
              description: true,
              quantity: true,
              lineTotalPaisa: true,
              orderItem: {
                select: {
                  menuItemId: true,
                  menuItem: { select: { category: { select: { name: true } } } },
                },
              },
            },
          },
        },
      }),
      prisma.invoice.findMany({
        where: { restaurantId, businessDate, status: 'VOID' },
        orderBy: { voidedAt: 'asc' },
        select: {
          invoiceNumber: true,
          fiscalYearStartBsYear: true,
          orderId: true,
          grandTotalPaisa: true,
          voidReason: true,
          voidedAt: true,
          voidedByStaff: staffRef,
        },
      }),
      prisma.payment.findMany({
        where: { restaurantId, voidedAt: { not: null }, invoice: { businessDate } },
        orderBy: { voidedAt: 'asc' },
        select: {
          method: true,
          amountPaisa: true,
          voidReason: true,
          voidedAt: true,
          voidedByStaff: staffRef,
          invoice: { select: { invoiceNumber: true } },
        },
      }),
      prisma.orderItemCancellation.findMany({
        where: { orderItem: { order: { restaurantId, businessDate } } },
        orderBy: { cancelledAt: 'asc' },
        select: {
          quantity: true,
          reason: true,
          cancelledAt: true,
          cancelledByStaff: staffRef,
          orderItem: {
            select: {
              nameSnapshot: true,
              unitPricePaisa: true,
              order: { select: { orderNumber: true } },
            },
          },
        },
      }),
      prisma.kot.findMany({
        where: { restaurantId, status: 'VOID', order: { businessDate } },
        orderBy: { voidedAt: 'asc' },
        select: {
          kotNumber: true,
          voidReason: true,
          voidedAt: true,
          voidedByStaff: staffRef,
          order: { select: { orderNumber: true } },
        },
      }),
      prisma.order.findMany({
        where: { restaurantId, businessDate, status: { in: ['DRAFT', 'OPEN'] } },
        orderBy: { orderNumber: 'asc' },
        select: { id: true, orderNumber: true, status: true, table: { select: { name: true } } },
      }),
      listShiftsForDay(prisma, restaurantId, businessDate),
    ]);

  // ---------------------------------------------------------------- sales
  const sum = (pick: (row: (typeof invoices)[number]) => number): number =>
    invoices.reduce((total, row) => total + pick(row), 0);
  const grandTotalPaisa = sum((r) => r.grandTotalPaisa);

  // ------------------------------------------------------------- payments
  const methods = new Map<PaymentMethod, { count: number; amountPaisa: number }>();
  let unpaidInvoiceCount = 0;
  let paidPaisa = 0;
  for (const invoice of invoices) {
    let paidOnThis = 0;
    for (const payment of invoice.payments) {
      const slot = methods.get(payment.method) ?? { count: 0, amountPaisa: 0 };
      slot.count += 1;
      slot.amountPaisa += payment.amountPaisa;
      methods.set(payment.method, slot);
      paidOnThis += payment.amountPaisa;
    }
    paidPaisa += paidOnThis;
    if (paidOnThis < invoice.grandTotalPaisa) unpaidInvoiceCount += 1;
  }
  const byMethod: MethodTotalDto[] = METHOD_ORDER.flatMap((method) => {
    const slot = methods.get(method);
    return slot === undefined ? [] : [{ method, ...slot }];
  });

  // ---------------------------------------------------------------- items
  // Keyed by menu item where the line still knows it, by description where the
  // order item has since been removed - the line's own snapshot is the name.
  const items = new Map<string, ItemSalesDto & { quantity: number; totalPaisa: number }>();
  for (const invoice of invoices) {
    for (const line of invoice.lines) {
      const key = line.orderItem?.menuItemId ?? `text:${line.description}`;
      const slot = items.get(key) ?? {
        name: line.description,
        category: line.orderItem?.menuItem.category.name ?? 'Uncategorised',
        quantity: 0,
        totalPaisa: 0,
      };
      slot.quantity += line.quantity;
      slot.totalPaisa += line.lineTotalPaisa;
      items.set(key, slot);
    }
  }
  const itemRows = [...items.values()].sort(
    (a, b) =>
      b.totalPaisa - a.totalPaisa || b.quantity - a.quantity || a.name.localeCompare(b.name),
  );
  const categories = new Map<string, CategorySalesDto & { quantity: number; totalPaisa: number }>();
  for (const item of itemRows) {
    const slot = categories.get(item.category) ?? {
      category: item.category,
      quantity: 0,
      totalPaisa: 0,
    };
    slot.quantity += item.quantity;
    slot.totalPaisa += item.totalPaisa;
    categories.set(item.category, slot);
  }

  // ---------------------------------------------------------------- staff
  const staff = new Map<
    string,
    StaffSalesDto & { invoiceCount: number; grandTotalPaisa: number }
  >();
  for (const invoice of invoices) {
    const slot = staff.get(invoice.issuedByStaff.id) ?? {
      staff: invoice.issuedByStaff,
      invoiceCount: 0,
      grandTotalPaisa: 0,
    };
    slot.invoiceCount += 1;
    slot.grandTotalPaisa += invoice.grandTotalPaisa;
    staff.set(invoice.issuedByStaff.id, slot);
  }

  const discounted = invoices.filter((invoice) => invoice.discountPaisa > 0);

  return {
    businessDate,
    refunds: await refundSummary(prisma, restaurantId, businessDate),
    expenses: await expenseSummary(prisma, restaurantId, businessDate, businessDate),
    generatedAt: new Date().toISOString(),
    creditCollections: await creditCollections(prisma, restaurantId, businessDate),
    sales: {
      invoiceCount: invoices.length,
      subtotalPaisa: sum((r) => r.subtotalPaisa),
      discountPaisa: sum((r) => r.discountPaisa),
      serviceChargePaisa: sum((r) => r.serviceChargePaisa),
      vatPaisa: sum((r) => r.vatPaisa),
      roundingPaisa: sum((r) => r.roundingAdjustmentPaisa),
      grandTotalPaisa,
      averageBillPaisa: invoices.length === 0 ? 0 : Math.round(grandTotalPaisa / invoices.length),
    },
    byOrderType: ORDER_TYPES.map((type) => {
      const rows = invoices.filter((invoice) => invoice.order.type === type);
      return {
        type,
        invoiceCount: rows.length,
        grandTotalPaisa: rows.reduce((total, row) => total + row.grandTotalPaisa, 0),
      };
    }),
    payments: {
      byMethod,
      totalPaisa: paidPaisa,
      outstandingPaisa: Math.max(0, grandTotalPaisa - paidPaisa),
      unpaidInvoiceCount,
    },
    items: itemRows,
    categories: [...categories.values()].sort((a, b) => b.totalPaisa - a.totalPaisa),
    staff: [...staff.values()].sort((a, b) => b.grandTotalPaisa - a.grandTotalPaisa),
    discounts: {
      totalPaisa: discounted.reduce((total, row) => total + row.discountPaisa, 0),
      rows: discounted.map((invoice) => ({
        invoiceNumber: invoice.invoiceNumber,
        fiscalYearLabel: formatNepaliFiscalYear(invoice.fiscalYearStartBsYear),
        orderId: invoice.order.id,
        amountPaisa: invoice.discountPaisa,
        approvedBy: invoice.order.discountApprovedByStaff,
      })),
    },
    corrections: {
      voidedInvoices: voidedInvoices.flatMap((row) =>
        row.voidedAt === null || row.voidedByStaff === null
          ? []
          : [
              {
                invoiceNumber: row.invoiceNumber,
                fiscalYearLabel: formatNepaliFiscalYear(row.fiscalYearStartBsYear),
                orderId: row.orderId,
                grandTotalPaisa: row.grandTotalPaisa,
                reason: row.voidReason ?? '',
                voidedBy: row.voidedByStaff,
                voidedAt: row.voidedAt.toISOString(),
              },
            ],
      ),
      voidedPayments: voidedPayments.flatMap((row) =>
        row.voidedAt === null || row.voidedByStaff === null
          ? []
          : [
              {
                invoiceNumber: row.invoice.invoiceNumber,
                method: row.method,
                amountPaisa: row.amountPaisa,
                reason: row.voidReason ?? '',
                voidedBy: row.voidedByStaff,
                voidedAt: row.voidedAt.toISOString(),
              },
            ],
      ),
      cancelledItems: cancellations.map((row) => ({
        orderNumber: row.orderItem.order.orderNumber,
        name: row.orderItem.nameSnapshot,
        quantity: row.quantity,
        valuePaisa: row.quantity * row.orderItem.unitPricePaisa,
        reason: row.reason,
        cancelledBy: row.cancelledByStaff,
        cancelledAt: row.cancelledAt.toISOString(),
      })),
      voidedTickets: voidedKots.flatMap((row) =>
        row.voidedAt === null || row.voidedByStaff === null
          ? []
          : [
              {
                orderNumber: row.order.orderNumber,
                kotNumber: row.kotNumber,
                reason: row.voidReason ?? '',
                voidedBy: row.voidedByStaff,
                voidedAt: row.voidedAt.toISOString(),
              },
            ],
      ),
    },
    shifts,
    unbilledOrders: unbilled.map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      tableName: order.table?.name ?? null,
    })),
  };
}
