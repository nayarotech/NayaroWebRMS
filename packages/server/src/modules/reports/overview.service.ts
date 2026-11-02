import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { PaymentMethod, SalesOverviewResponse } from '@nayaro/shared';
import { resolveBusinessDate } from '../../utils/businessDate';

const overviewQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(14),
});

/** Business dates from `days - 1` days before `today` up to `today`, oldest first. */
function trailingDates(today: string, days: number): string[] {
  const end = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (days - 1 - index));
    return day.toISOString().slice(0, 10);
  });
}

function hourIn(timeZone: string, instant: Date): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
        instant,
      ),
    );
  } catch {
    return instant.getHours();
  }
}

/**
 * The dashboard's figures, computed from the same ACTIVE invoices and live
 * payments the end-of-day report uses, so the two can never disagree.
 */
export async function getSalesOverview(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawQuery: unknown,
): Promise<SalesOverviewResponse> {
  const { days } = overviewQuerySchema.parse(rawQuery);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { restaurantId },
    select: { businessDayStartsAtMinutes: true, timezone: true },
  });
  const today = resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone);
  const dates = trailingDates(today, days);
  const from = dates[0]!;

  const [invoices, lines, payments, openOrders, kots, ingredients] = await Promise.all([
    prisma.invoice.findMany({
      where: { restaurantId, status: 'ACTIVE', businessDate: { gte: from, lte: today } },
      select: { businessDate: true, grandTotalPaisa: true, issuedAt: true },
    }),
    prisma.invoiceLine.findMany({
      where: { invoice: { restaurantId, status: 'ACTIVE', businessDate: { gte: from, lte: today } } },
      select: { description: true, quantity: true, lineTotalPaisa: true },
    }),
    prisma.payment.findMany({
      where: {
        restaurantId,
        voidedAt: null,
        invoice: { status: 'ACTIVE', businessDate: { gte: from, lte: today } },
      },
      select: { method: true, amountPaisa: true },
    }),
    prisma.order.findMany({
      where: { restaurantId, closedAt: null, status: { in: ['DRAFT', 'OPEN', 'BILLED'] } },
      select: { type: true, status: true, tableId: true },
    }),
    prisma.kot.groupBy({
      by: ['status'],
      where: { restaurantId, status: { in: ['NEW', 'PREPARING', 'READY'] } },
      _count: { _all: true },
    }),
    prisma.ingredient.findMany({
      where: { restaurantId, isActive: true },
      select: { onHandMilli: true, lowStockMilli: true },
    }),
  ]);

  const byDate = new Map(dates.map((date) => [date, { salesPaisa: 0, invoiceCount: 0 }]));
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, salesPaisa: 0, invoiceCount: 0 }));
  for (const invoice of invoices) {
    const day = byDate.get(invoice.businessDate);
    if (day) {
      day.salesPaisa += invoice.grandTotalPaisa;
      day.invoiceCount += 1;
    }
    if (invoice.businessDate === today) {
      const slot = hourly[hourIn(settings.timezone, invoice.issuedAt)]!;
      slot.salesPaisa += invoice.grandTotalPaisa;
      slot.invoiceCount += 1;
    }
  }

  const items = new Map<string, { quantity: number; salesPaisa: number }>();
  for (const line of lines) {
    const item = items.get(line.description) ?? { quantity: 0, salesPaisa: 0 };
    item.quantity += line.quantity;
    item.salesPaisa += line.lineTotalPaisa;
    items.set(line.description, item);
  }

  const mix = new Map<PaymentMethod, number>();
  for (const payment of payments) {
    mix.set(payment.method, (mix.get(payment.method) ?? 0) + payment.amountPaisa);
  }

  const kitchen = { NEW: 0, PREPARING: 0, READY: 0 };
  for (const row of kots) {
    if (row.status === 'NEW' || row.status === 'PREPARING' || row.status === 'READY') {
      kitchen[row.status] = row._count._all;
    }
  }

  return {
    businessDate: today,
    days: dates.map((date) => ({ businessDate: date, ...byDate.get(date)! })),
    hourly,
    topItems: [...items.entries()]
      .map(([name, totals]) => ({ name, ...totals }))
      .sort((left, right) => right.salesPaisa - left.salesPaisa)
      .slice(0, 8),
    paymentMix: [...mix.entries()]
      .map(([method, amountPaisa]) => ({ method, amountPaisa }))
      .sort((left, right) => right.amountPaisa - left.amountPaisa),
    live: {
      openOrders: openOrders.length,
      occupiedTables: new Set(openOrders.map((row) => row.tableId).filter((id) => id !== null)).size,
      awaitingPayment: openOrders.filter((row) => row.status === 'BILLED').length,
      openTakeaways: openOrders.filter((row) => row.type === 'TAKEAWAY').length,
      kitchen,
      lowStockIngredients: ingredients.filter((row) => row.onHandMilli <= row.lowStockMilli).length,
    },
  };
}
